"use strict";
/**
 * health.js — 2 อย่างที่เพิ่มตามที่ User ขอ:
 *   1) collectErrors() — รวม "ทุกสายพังตรงไหนบ้าง" ไว้ที่เดียว
 *   2) collectVitals() — RAM / token / ดิสก์ ที่ AI กินอยู่จริง
 *
 * หลักการเดียวกับไฟล์อื่น: อ่านอย่างเดียว · copy sqlite ก่อนเปิด · ของจริงเท่านั้น
 *
 * ⚠️ ตั้งใจ *ไม่* ดึง Windows Event Log: ตรวจแล้ว 7 วันมี error เดียว
 * (Firefox agent) = แผงจะว่างเปล่า ไม่คุ้มพื้นที่บนจอ
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");

const HOME = os.homedir();
const CODEX = path.join(HOME, ".codex");
const CLAUDE_PROJ = path.join(HOME, ".claude", "projects");

function openSnapshot(src, tag) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); } catch (_) { return null; }
  if (!fs.existsSync(src)) return null;
  const tmp = path.join(os.tmpdir(), "aiflow-" + tag);
  try {
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.copyFileSync(src + ext, tmp + ext); } catch (_) {}
    }
    return new DatabaseSync(tmp);
  } catch (_) { return null; }
}

function clean(s, n = 130) {
  if (!s) return "";
  return String(s).replace(/\s+/g, " ").trim().slice(0, n);
}

function tailLines(file, bytes = 400 * 1024) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, start);
    const lines = buf.toString("utf8").split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch (_) { return []; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {} }
}

/* ============================================================ ERRORS */

/** Codex: WARN/ERROR จาก logs_2.sqlite (26k+ แถว) */
function codexErrors() {
  const out = [];
  const db = openSnapshot(path.join(CODEX, "logs_2.sqlite"), "err-cx.sqlite");
  if (!db) return out;
  try {
    const rows = db.prepare(
      "SELECT ts, level, target, feedback_log_body FROM logs " +
      "WHERE level IN ('ERROR','WARN') ORDER BY id DESC LIMIT 25"
    ).all();
    for (const r of rows) {
      out.push({
        ts: Number(r.ts) * 1000,
        ch: "codex",
        level: r.level === "ERROR" ? "error" : "warn",
        text: clean(r.feedback_log_body),
        where: clean(String(r.target || "").split("::").pop(), 40),
      });
    }
  } catch (_) {}
  try { db.close(); } catch (_) {}
  return out;
}

/**
 * Claude Code: tool ที่ล้มเหลว (is_error) จาก transcript
 * นี่คือ "AI ทำงานพลาดตรงไหน" ซึ่งไม่มีที่ไหนเก็บรวมไว้เลย
 */
function claudeErrors() {
  const out = [];
  let dirs = [];
  try {
    dirs = fs.readdirSync(CLAUDE_PROJ)
      .map((d) => path.join(CLAUDE_PROJ, d))
      .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
  } catch (_) { return out; }

  const files = [];
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const f = path.join(dir, n);
      try { files.push({ f, m: fs.statSync(f).mtimeMs }); } catch (_) {}
    }
  }
  files.sort((a, b) => b.m - a.m);

  // ดูเฉพาะ 3 session ล่าสุด (ไฟล์ใหญ่มาก อ่านทั้งหมดไม่ไหว)
  for (const { f, m } of files.slice(0, 3)) {
    // จับคู่ tool_use id → ชื่อ tool เพื่อบอกได้ว่าพังตอนใช้อะไร
    const toolName = new Map();
    for (const line of tailLines(f)) {
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      const ts = j.timestamp ? Date.parse(j.timestamp) : m;
      const c = j.message && j.message.content;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b.type === "tool_use" && b.id) toolName.set(b.id, b.name);
        if (b.type === "tool_result" && b.is_error) {
          const body = typeof b.content === "string"
            ? b.content
            : (Array.isArray(b.content) ? b.content.map((x) => x.text || "").join(" ") : "");
          out.push({
            ts,
            ch: "claude",
            level: "error",
            text: clean(body.replace(/<\/?tool_use_error>/g, "")),
            where: toolName.get(b.tool_use_id) || "tool",
          });
        }
      }
    }
  }
  return out;
}

/** cron ที่รันแล้วพัง (มี status/error ตรงๆ) */
function cronErrors(ocRaw) {
  const out = [];
  for (const r of (ocRaw && ocRaw.cronRuns) || []) {
    if (r.ok) continue;
    out.push({ ts: r.ts, ch: "cron", level: "error", text: clean(r.name + " รันไม่สำเร็จ"), where: "cron" });
  }
  return out;
}

/** delivery ที่ส่งไม่ออก (เช่น gateway→telegram ที่พังอยู่) */
function deliveryErrors(ocRaw) {
  const out = [];
  for (const d of (ocRaw && ocRaw.deliveries) || []) {
    if (d.ok) continue;
    out.push({
      ts: d.ts,
      ch: "telegram",
      level: "error",
      text: clean(d.error || `ส่งเข้า ${d.channel} ไม่สำเร็จ`),
      where: "gateway→telegram",
    });
  }
  return out;
}

/** Scheduled Task ที่ exit code ไม่ใช่ 0 */
function taskErrors(taskRuns) {
  const out = [];
  for (const t of taskRuns || []) {
    if (t.ok || !t.ts) continue;
    out.push({ ts: t.ts, ch: "tasks", level: "error", text: clean(`${t.name} · ผลลัพธ์ผิดปกติ`), where: "schtasks" });
  }
  return out;
}

/** รวมทุกสาย เรียงใหม่→เก่า */
function collectErrors(ocRaw, taskRuns) {
  let all = [];
  try { all = all.concat(codexErrors()); } catch (_) {}
  try { all = all.concat(claudeErrors()); } catch (_) {}
  try { all = all.concat(cronErrors(ocRaw)); } catch (_) {}
  try { all = all.concat(deliveryErrors(ocRaw)); } catch (_) {}
  try { all = all.concat(taskErrors(taskRuns)); } catch (_) {}

  all = all.filter((e) => e.ts && e.text);
  all.sort((a, b) => b.ts - a.ts);

  // กันข้อความซ้ำติดกัน (log บางตัวยิงรัวเป็นสิบรอบ)
  const seen = new Map();
  const dedup = [];
  for (const e of all) {
    const key = e.ch + "|" + e.text.slice(0, 60);
    const hit = seen.get(key);
    if (hit) { hit.count++; continue; }
    e.count = 1;
    seen.set(key, e);
    dedup.push(e);
  }

  const dayAgo = Date.now() - 24 * 3600e3;
  return {
    items: dedup.slice(0, 40),
    total: dedup.length,
    recent: dedup.filter((e) => e.ts > dayAgo).length,
  };
}

/* ============================================================ VITALS */

let _vitalsCache = { ts: 0, data: null };

/**
 * RAM ที่เครื่องมือ AI/dev กินอยู่
 *
 * ⚠️ ไม่ใช้ powershell แล้ว — ส่งสคริปต์ยาวๆ ผ่าน -Command เจอปัญหา `$` โดนกลืน
 * ระหว่างทาง (ได้ stdout ว่างเปล่า ไม่มี error = ดีบักยาก)
 * → ใช้ `tasklist` แทน: เป็น CSV เรียบๆ ไม่ต้อง escape อะไรเลย และเร็วกว่า
 */
function readProcessRam(cb) {
  execFile("tasklist", ["/fo", "csv", "/nh"], { windowsHide: true, maxBuffer: 8e6, timeout: 9000 },
    (err, stdout) => {
      if (err || !stdout) return cb([]);
      const groups = new Map();
      for (const line of stdout.split(/\r?\n/)) {
        if (!line.trim()) continue;
        // "image","pid","session","session#","mem usage"
        const m = line.match(/^"([^"]+)","(\d+)","[^"]*","[^"]*","([^"]+)"/);
        if (!m) continue;
        const name = m[1].replace(/\.exe$/i, "");
        const kb = parseInt(m[3].replace(/[^\d]/g, ""), 10) || 0;

        let label = null;
        if (/^Antigravity$/i.test(name)) label = "Antigravity";
        else if (/^Code$/i.test(name)) label = "VS Code";
        else if (/^codex$/i.test(name)) label = "Codex";
        else if (/^node$/i.test(name)) label = "node";
        else if (/^firefox$/i.test(name)) label = "Firefox";
        else if (/^chrome$/i.test(name)) label = "Chrome";
        if (!label) continue;

        const g = groups.get(label) || { name: label, procs: 0, kb: 0 };
        g.procs++; g.kb += kb;
        groups.set(label, g);
      }
      const out = [...groups.values()]
        .map((g) => ({ name: g.name, procs: g.procs, mb: Math.round(g.kb / 1024) }))
        .filter((g) => g.mb > 0)
        .sort((a, b) => b.mb - a.mb);
      cb(out);
    });
}

/** token ที่ใช้ไปใน session ล่าสุดของ Claude Code */
function readTokens() {
  const out = { output: 0, cacheRead: 0, input: 0, turns: 0 };
  try {
    const dir = path.join(CLAUDE_PROJ, "d--git");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f: path.join(dir, f), m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return out;
    for (const line of tailLines(files[0].f, 900 * 1024)) {
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      const u = j.message && j.message.usage;
      if (!u) continue;
      out.turns++;
      out.input += u.input_tokens || 0;
      out.output += u.output_tokens || 0;
      out.cacheRead += u.cache_read_input_tokens || 0;
    }
  } catch (_) {}
  return out;
}

/** พื้นที่ดิสก์ที่ AI แต่ละตัวกิน (เดินโฟลเดอร์เอง เร็วพอเพราะไฟล์ไม่เยอะ) */
function dirSize(dir, budgetMs) {
  const stop = Date.now() + (budgetMs || 400);
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    if (Date.now() > stop) break; // กันค้างถ้าโฟลเดอร์ใหญ่ผิดคาด
    const d = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch (_) {} }
    }
  }
  return total;
}

function readDisk() {
  const targets = [
    { name: "Claude Code", dir: path.join(HOME, ".claude") },
    { name: "Codex", dir: path.join(CODEX) },
    { name: "Antigravity", dir: path.join(HOME, ".gemini", "antigravity") },
    { name: "OpenClaw", dir: path.join(HOME, ".openclaw") },
  ];
  const out = [];
  for (const t of targets) {
    if (!fs.existsSync(t.dir)) continue;
    out.push({ name: t.name, mb: Math.round(dirSize(t.dir, 500) / 1048576) });
  }
  return out.sort((a, b) => b.mb - a.mb);
}

/** รวมสุขภาพเครื่อง (cache 60 วิ เพราะ powershell+เดินดิสก์ช้า) */
function collectVitals(cb) {
  const now = Date.now();
  if (_vitalsCache.data && now - _vitalsCache.ts < 60e3) return cb(_vitalsCache.data);

  readProcessRam((ram) => {
    /**
     * ตัวเลข RAM ต้องตรงกับ Task Manager (User สั่งเอง)
     * ตรวจแล้ว: os.totalmem/freemem ให้ค่าตรงกับ Task Manager เป๊ะ
     *   total 15.87GB · used 10.44GB · free 5.43GB
     * ⚠️ เดิมเอา "RAM ที่ AI กิน" ไปโชว์เป็นตัวเลขหลัก → User ดูแล้วไม่รู้ว่า
     * เครื่องเหลือเท่าไหร่จริงๆ → เปลี่ยนเป็นโชว์ used/total ของเครื่อง เป็นหลัก
     * แล้วให้ "AI กินเท่าไหร่" เป็นตัวเลขรอง
     */
    const totalGb = os.totalmem() / 1073741824;
    const freeGb = os.freemem() / 1073741824;
    const usedGb = totalGb - freeGb;
    const toolsMb = ram.reduce((s, x) => s + (x.mb || 0), 0);
    const r2 = (n) => Math.round(n * 100) / 100;

    const data = {
      ram: {
        byTool: ram.slice(0, 6),
        toolsMb,
        toolsGb: r2(toolsMb / 1024),
        totalGb: r2(totalGb),
        usedGb: r2(usedGb),
        freeGb: r2(freeGb),
        usedPct: Math.round((usedGb / totalGb) * 100),
        // สัดส่วนที่ AI กินเทียบกับที่ใช้ไปทั้งหมด (ดูว่า AI คือตัวการหลักไหม)
        toolsShare: usedGb > 0 ? Math.round((toolsMb / 1024 / usedGb) * 100) : 0,
      },
      tokens: readTokens(),
      disk: readDisk(),
      uptimeH: Math.round(os.uptime() / 3600),
    };
    _vitalsCache = { ts: now, data };
    cb(data);
  });
}

/* ============================================ ตอนนี้ใครทำอะไรอยู่ */

/**
 * "กำลังทำงานอยู่ตอนนี้" — ดึงจาก process จริง ไม่ใช่จากไฟล์ log
 * ตอบคำถาม: เปิดอะไรค้างไว้บ้าง · เปิดมานานแค่ไหน · ตัวไหนกินเครื่อง
 */
let _runCache = { ts: 0, data: null };

function collectRunning(cb) {
  /**
   * powershell ช้า (~1s) แต่ poll ทุก 1.5 วิ → ต้อง cache ไม่งั้นเผา CPU เปล่า
   *
   * ⚠️ 2026-08-05: cache 20 วิ = spawn powershell ~180 ครั้ง/ชม. ตอนเปิดหน้าเว็บค้างไว้
   * → User เห็นหน้าต่าง PowerShell "เด้งแว็ปๆ" ตลอดเวลาโดยไม่รู้ว่ามาจากไหน
   * (ยืนยันจาก event log: PS start ทุก ~22 วิ ตรงกับ 20 วิ cache + 1.5 วิ poll เป๊ะ)
   * → ขยายเป็น 120 วิ (ลดการ spawn 6 เท่า) — "ใครเปิดค้างอยู่" ไม่ต้องสดระดับวินาที
   */
  const now = Date.now();
  if (_runCache.data && now - _runCache.ts < 120e3) return cb(_runCache.data);

  const done = (v) => { _runCache = { ts: Date.now(), data: v }; cb(v); };

  // WMIC ตายแล้วใน Windows ใหม่ → ใช้ powershell แต่สั่งสั้นๆ (บทเรียน: คำสั่งยาว $ โดนกลืน)
  const ps = "Get-CimInstance Win32_Process | " +
    "Where-Object { $_.Name -match 'node|codex|Antigravity|Code|ollama' } | " +
    "Select-Object Name,ProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress -Depth 2";

  // -WindowStyle Hidden ซ้อนกับ windowsHide: node ซ่อนหน้าต่าง "ใหม่" ได้ก็จริง
  // แต่ถ้า server ถูกสตาร์ตจาก .bat (มี console อยู่แล้ว) conhost ยังแวบได้ → กันสองชั้น
  execFile("powershell", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", ps],
    { windowsHide: true, maxBuffer: 8e6, timeout: 9000 }, (err, stdout) => {
      if (err || !stdout || !stdout.trim()) return done([]);
      let list = [];
      try {
        list = JSON.parse(stdout);
        if (!Array.isArray(list)) list = [list];
      } catch (_) { return done([]); }

      const out = [];
      for (const p of list) {
        const cmd = String(p.CommandLine || "");
        let label = null, detail = "";

        if (/Antigravity\.exe/i.test(p.Name) && !/--type=/.test(cmd)) {
          label = "Antigravity"; detail = "IDE agent";
        } else if (/^codex/i.test(p.Name)) {
          label = "Codex"; detail = "OpenAI agent";
        } else if (/^node/i.test(p.Name)) {
          if (/openclaw/i.test(cmd)) { label = "OpenClaw gateway"; detail = "service"; }
          else if (/ai-flow|server[\\/]index/i.test(cmd)) { label = "AI Flow"; detail = "แอปนี้เอง"; }
          else if (/Adobe/i.test(cmd)) { label = null; }
          else { label = "node"; detail = clean(cmd.split(/\s+/).slice(-1)[0], 30); }
        } else if (/^Code\.exe$/i.test(p.Name) && !/--type=/.test(cmd)) {
          // ⚠️ Win32_Process.Name มี .exe ต่อท้ายเสมอ — /^Code$/ ไม่เคย match
          label = "VS Code"; detail = "editor";
        }
        if (!label) continue;

        // CreationDate มาเป็น /Date(1234567890)/ หรือ ISO แล้วแต่เวอร์ชัน
        let started = 0;
        const raw = p.CreationDate;
        if (raw) {
          const m = String(raw).match(/\/Date\((\d+)\)\//);
          if (m) started = Number(m[1]);
          else { const d = Date.parse(raw); if (!isNaN(d)) started = d; }
        }
        out.push({ name: label, detail, pid: p.ProcessId, started });
      }

      // ยุบตัวซ้ำ (VS Code/Antigravity มีหลาย process) เอาตัวที่เปิดก่อนสุด
      const byName = new Map();
      for (const p of out) {
        const cur = byName.get(p.name);
        if (!cur || (p.started && p.started < cur.started)) byName.set(p.name, p);
      }
      done([...byName.values()].sort((a, b) => (a.started || 0) - (b.started || 0)));
    });
}

module.exports = { collectErrors, collectVitals, collectRunning };

"use strict";
/**
 * sources-extra.js — สายที่ตกสำรวจรอบแรก
 *
 * ⚠️ ที่มา: รอบแรกผม map เฉพาะสายที่ "รู้อยู่แล้ว" จาก CLAUDE.md แล้วเรียกว่า
 * "ทุกช่องทาง" ซึ่งผิด — User ทักว่า "เครื่องกูมีแค่นั้นจริงๆ เหรอ" แล้วพอ scan
 * เครื่องจริงก็เจอของที่พลาดไปเยอะ โดยเฉพาะ Codex ที่ใหญ่กว่า OpenClaw อีก
 *
 * บทเรียน: อย่า map จากความจำ ให้ scan ของจริงก่อนเสมอ
 *
 * ทุก source คืน shape เดียวกับ sources.js + เพิ่ม field `tier`:
 *   tier 1 = agent เต็มตัว (ทำงานเอง มี session/memory)
 *   tier 2 = ผู้ช่วยในเครื่องมือ (ต้องมีคนกด)
 *   tier 3 = ท่อ/ทางเชื่อม (ไม่ใช่ AI แต่เป็นทางที่ AI ใช้)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const HOME = os.homedir();
const CODEX = path.join(HOME, ".codex");
const ANTI = path.join(HOME, ".gemini", "antigravity");
const VSCODE_EXT = path.join(HOME, ".vscode", "extensions");

function shorten(s, n = 90) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/** เปิด sqlite แบบ copy ไป temp ก่อน (กันชน WAL ของ process ที่รันอยู่) */
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

/* ------------------------------------------------------- 1) OpenAI Codex */

/**
 * Codex = agent ของ OpenAI ที่มากับ ChatGPT extension ใน VS Code
 * ข้อมูลจริง: ~/.codex (115MB) — threads (state_5) + logs (logs_2, 26k+ แถว)
 * threads เก็บของดี: model, cwd, git_branch, git_origin_url, prompt แรก
 */
function readCodex() {
  const feed = [];
  let lastTs = 0;
  let threads = [];
  let model = "";
  let logRows = 0;
  let livePid = null;

  const st = openSnapshot(path.join(CODEX, "state_5.sqlite"), "cx-state.sqlite");
  if (st) {
    try {
      threads = st.prepare(
        "SELECT id, title, cwd, model, git_branch, updated_at_ms, created_at_ms, source, tokens_used " +
        "FROM threads ORDER BY updated_at_ms DESC LIMIT 20"
      ).all();
      for (const t of threads) {
        const ts = Number(t.updated_at_ms || t.created_at_ms || 0);
        if (ts > lastTs) lastTs = ts;
        if (!model && t.model) model = t.model;
        const where = t.cwd ? path.basename(String(t.cwd).replace(/^\\\\\?\\/, "")) : "";
        feed.push({
          ts,
          text: shorten(`${t.title || "(ไม่มีหัวข้อ)"}${where ? " · " + where : ""}`, 80),
          ok: true,
        });
      }
    } catch (_) {}
    try { st.close(); } catch (_) {}
  }

  // logs = สัญญาณชีพจริง (เขียนตลอดเวลาที่ codex.exe รันอยู่)
  const lg = openSnapshot(path.join(CODEX, "logs_2.sqlite"), "cx-logs.sqlite");
  if (lg) {
    try {
      logRows = lg.prepare("SELECT COUNT(*) c FROM logs").get().c;
      const recent = lg.prepare(
        "SELECT ts, level, target, process_uuid FROM logs ORDER BY id DESC LIMIT 5"
      ).all();
      for (const r of recent) {
        const ts = Number(r.ts) * 1000;
        if (ts > lastTs) lastTs = ts;
        if (!livePid && r.process_uuid) {
          const m = String(r.process_uuid).match(/pid:(\d+)/);
          if (m) livePid = m[1];
        }
      }
    } catch (_) {}
    try { lg.close(); } catch (_) {}
  }

  feed.sort((a, b) => b.ts - a.ts);
  const age = lastTs ? Date.now() - lastTs : Infinity;

  return {
    ch: "codex",
    tier: 1,
    label: "Codex (OpenAI)",
    sub: model || "gpt-5.x",
    state: !lastTs ? "dead" : (age < 5 * 60e3 ? "live" : (age < 24 * 3600e3 ? "armed" : "idle")),
    lastTs,
    stat: `${threads.length} thread`,
    stat2: livePid ? `กำลังรัน · pid ${livePid}` : `${logRows.toLocaleString()} log`,
    feed: feed.slice(0, 8),
  };
}

/* --------------------------------------------- 2) Antigravity (ของจริง) */

/**
 * เดิมผมดูแค่ mtime ของไฟล์ scratch ซึ่งหยาบมาก
 * ของจริง Antigravity เก็บ conversations (.pb) + brain ไว้ใน ~/.gemini/antigravity
 *
 * ⚠️ ข้อจำกัดที่ต้องซื่อสัตย์: .pb เป็น protobuf ที่บีบอัด → **อ่านเนื้อหาไม่ได้**
 * (ลองดึง printable string แล้วได้ 0 ท่อน) เพราะงั้นบอกได้แค่
 * "คุยกี่รอบ / ขยับเมื่อไหร่" ไม่ใช่ "คุยว่าอะไร" — อย่าเคลมเกินจริง
 */
function readAntigravityDeep() {
  const feed = [];
  let lastTs = 0;
  let convos = 0, brainFiles = 0;

  try {
    const cdir = path.join(ANTI, "conversations");
    const list = fs.readdirSync(cdir)
      .filter((f) => /\.(pb|db)$/.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(cdir, f));
        return { f, m: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.m - a.m);
    convos = list.length;
    for (const c of list.slice(0, 6)) {
      if (c.m > lastTs) lastTs = c.m;
      feed.push({
        ts: c.m,
        text: `คุย ${c.f.slice(0, 8)} · ${(c.size / 1024).toFixed(0)}KB`,
        ok: true,
      });
    }
  } catch (_) {}

  try {
    brainFiles = fs.readdirSync(path.join(ANTI, "brain")).length;
  } catch (_) {}

  const age = lastTs ? Date.now() - lastTs : Infinity;
  return {
    ch: "anti",
    tier: 1,
    label: "Antigravity (Gemini)",
    sub: "IDE agent",
    state: !lastTs ? "dead" : (age < 15 * 60e3 ? "live" : (age < 12 * 3600e3 ? "armed" : "idle")),
    lastTs,
    stat: `${convos} บทสนทนา`,
    stat2: `brain ${brainFiles} ไฟล์`,
    // ความซื่อสัตย์: บอกให้รู้ว่าอ่านเนื้อหาไม่ได้
    note: "อ่านได้แค่ว่าขยับเมื่อไหร่ (ไฟล์เข้ารหัส)",
    feed: feed.slice(0, 8),
  };
}

/* ------------------------------------- 3) ผู้ช่วยในเครื่องมือ (tier 2) */

/** VS Code AI extensions — ต้องมีคนกดถึงทำงาน ไม่ได้รันเอง */
function readVscodeAI() {
  const wanted = [
    { re: /^anthropic\.claude-code-/, name: "Claude Code" },
    { re: /^openai\.chatgpt-/, name: "ChatGPT / Codex" },
    { re: /^andjae\.claudecode-usage-/, name: "Claude usage" },
    { re: /^github\.copilot-/, name: "GitHub Copilot" },
  ];
  const found = [];
  let lastTs = 0;
  try {
    for (const d of fs.readdirSync(VSCODE_EXT)) {
      for (const w of wanted) {
        if (w.re.test(d)) {
          const ver = (d.match(/-(\d+\.\d+\.\d+)/) || [])[1] || "";
          let m = 0;
          try { m = fs.statSync(path.join(VSCODE_EXT, d)).mtimeMs; } catch (_) {}
          if (m > lastTs) lastTs = m;
          found.push({ name: w.name, ver, m });
        }
      }
    }
  } catch (_) {}

  found.sort((a, b) => b.m - a.m);
  return {
    ch: "vscode",
    tier: 2,
    label: "VS Code AI",
    sub: "ส่วนขยายในตัวแก้โค้ด",
    state: found.length ? "armed" : "dead",
    lastTs,
    stat: `${found.length} ส่วนขยาย`,
    stat2: found.map((f) => f.name).join(" · ") || "ไม่มี",
    feed: found.map((f) => ({ ts: f.m, text: `${f.name} ${f.ver}`, ok: true })),
  };
}

/** GitHub Copilot CLI — เรียกใช้ตอนอยาก audit/รีวิว ไม่ได้รันตลอด */
function readCopilotCli() {
  const base = path.join(HOME, "AppData", "Roaming", "npm", "node_modules", "@github", "copilot");
  let ver = "", lastTs = 0, exists = false;
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
    ver = pj.version || "";
    lastTs = fs.statSync(base).mtimeMs;
    exists = true;
  } catch (_) {}

  return {
    ch: "copilot",
    tier: 2,
    label: "Copilot CLI",
    sub: exists ? `v${ver}` : "ไม่ได้ติดตั้ง",
    state: exists ? "armed" : "dead",
    lastTs,
    stat: exists ? "พร้อมเรียกใช้" : "-",
    stat2: "ใช้ตรวจงานอิสระ (คนละโมเดล)",
    feed: exists ? [{ ts: lastTs, text: `ติดตั้ง v${ver}`, ok: true }] : [],
  };
}

/* ------------------------------------------ 4) ท่อ/ทางเชื่อม (tier 3) */

/** MCP servers ที่ผูกไว้กับโปรเจกต์ — ท่อให้ agent ต่อออกไปหาโปรแกรมอื่น */
function readMcp() {
  const servers = [];
  let lastTs = 0;
  try {
    const f = path.join(HOME, ".claude.json");
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    lastTs = fs.statSync(f).mtimeMs;
    for (const [proj, cfg] of Object.entries(j.projects || {})) {
      for (const [name, def] of Object.entries(cfg.mcpServers || {})) {
        servers.push({ name, proj: path.basename(proj), type: def.type || "stdio" });
      }
    }
    for (const [name, def] of Object.entries(j.mcpServers || {})) {
      servers.push({ name, proj: "global", type: def.type || "stdio" });
    }
  } catch (_) {}

  return {
    ch: "mcp",
    tier: 3,
    label: "MCP",
    sub: "ท่อต่อ agent → โปรแกรมอื่น",
    state: servers.length ? "armed" : "dead",
    lastTs,
    stat: `${servers.length} server`,
    stat2: servers.map((s) => s.name).join(" · ") || "ยังไม่ได้ตั้ง",
    feed: servers.map((s) => ({ ts: lastTs, text: `${s.name} (${s.proj})`, ok: true })),
  };
}

/** Chrome profile ที่ automation ใช้ (puppeteer) — ไม่ใช่ AI แต่เป็นมือให้ AI */
function readBrowserAutomation() {
  const feed = [];
  let lastTs = 0;
  const profiles = [];

  // chrome-profile ของ gumroad-factory = ตัวที่ automation ใช้จริง
  for (const p of [
    path.join("D:", "git", "gumroad-factory", "chrome-profile"),
    path.join("D:", "git", "gumroad-factory", "chrome-profile-render"),
  ]) {
    try {
      const st = fs.statSync(p);
      profiles.push({ name: path.basename(p), m: st.mtimeMs });
      if (st.mtimeMs > lastTs) lastTs = st.mtimeMs;
    } catch (_) {}
  }

  for (const p of profiles) feed.push({ ts: p.m, text: p.name, ok: true });

  const age = lastTs ? Date.now() - lastTs : Infinity;
  return {
    ch: "browser",
    tier: 3,
    label: "Browser automation",
    sub: "puppeteer + chrome profile",
    state: !profiles.length ? "dead" : (age < 6 * 3600e3 ? "armed" : "idle"),
    lastTs,
    stat: `${profiles.length} โปรไฟล์`,
    stat2: "ใช้ยิง Gumroad / Pinterest",
    feed,
  };
}

/* --------------------------------------- 7) BRAIN — สมองกลางที่ทุกตัวแชร์ */

/**
 * `~/.brain/` = ความรู้ส่วนกลางที่ AI ทุกตัวในเครื่องอ่านร่วมกัน
 *
 * สายนี้พิเศษกว่าตัวอื่น: มันไม่ใช่ "โปรแกรมที่รันอยู่" แต่เป็น **ตัวเชื่อมความรู้**
 * → วัดจาก (ก) ไฟล์ความรู้ถูกแก้ล่าสุดเมื่อไหร่ (ข) ทางเข้าของแต่ละ AI ยังต่ออยู่กี่ตัว
 */
function readBrain() {
  const BRAIN = path.join(HOME, ".brain");
  const feed = [];
  let lastTs = 0;
  let docs = 0;

  const CORE = ["README.md", "LESSONS.md", "TOOLS.md", "MACHINE.md", "SKILLS.md", "AGENTS.md"];
  for (const f of CORE) {
    try {
      const st = fs.statSync(path.join(BRAIN, f));
      docs++;
      if (st.mtimeMs > lastTs) lastTs = st.mtimeMs;
      feed.push({ ts: st.mtimeMs, text: `${f} · ${(st.size / 1024).toFixed(1)}KB`, ok: true });
    } catch (_) {}
  }
  feed.sort((a, b) => b.ts - a.ts);

  // ทางเข้าของแต่ละ AI ยังชี้มาที่ .brain อยู่ไหม (= สายยังต่อจริงหรือขาด)
  const ENTRIES = [
    { who: "claude", file: path.join("D:", "git", "CLAUDE.md") },
    { who: "codex", file: path.join("D:", "git", "AGENTS.md") },
    { who: "gateway", file: path.join(HOME, ".openclaw", "workspace", "MEMORY.md") },
  ];
  const wired = [];
  for (const e of ENTRIES) {
    try {
      if (/\.brain/.test(fs.readFileSync(e.file, "utf8"))) wired.push(e.who);
    } catch (_) {}
  }

  const missing = ENTRIES.length - wired.length;
  const age = lastTs ? Date.now() - lastTs : Infinity;

  return {
    ch: "brain",
    tier: 1,
    label: "BRAIN (สมองกลาง)",
    sub: "~/.brain",
    // ต่อครบ = live ตลอด (มันคือฐานความรู้ ไม่ใช่ process ที่ต้องวิ่ง)
    state: !docs ? "dead" : (missing > 0 ? "idle" : (age < 60 * 60e3 ? "live" : "armed")),
    lastTs,
    stat: `${docs} เอกสาร`,
    stat2: `ต่ออยู่ ${wired.length}/${ENTRIES.length} ตัว` + (missing ? " · มีสายขาด!" : ""),
    note: missing ? "AI บางตัวมองไม่เห็นสมองกลาง — รัน verify.js" : "",
    wired,
    feed: feed.slice(0, 8),
  };
}


/**
 * สายข่าวเศรษฐกิจ — news-alert.js
 * อ่านจาก state file จริง (ไฟล์ถูกเขียนทุกรอบที่สคริปต์รัน)
 * ไม่แตะแพลตฟอร์มโบรกใดๆ — feed มาจาก ForexFactory สาธารณะ
 */
function readNewsAlert() {
  const dir = path.join(__dirname, "..", "..", "news-alert");
  const script = path.join(dir, "news-alert.js");
  const state = path.join(dir, ".news-alert-state.json");

  if (!fs.existsSync(script)) {
    return { ch: "news", tier: 2, label: "news-alert", sub: "ยังไม่ได้ติดตั้ง",
             state: "dead", lastTs: 0, stat: "-", stat2: "", sent: 0, feed: [] };
  }

  let lastTs = 0, sent = 0, lastAlertTs = 0, feed = [];
  try {
    const st = fs.statSync(state);
    lastTs = st.mtimeMs;                       // รันรอบล่าสุดเมื่อไหร่
    const j = JSON.parse(fs.readFileSync(state, "utf8"));
    sent = (j.sent || []).length;
    // id = "<iso>|<country>|<title>" → เอาเวลาข่าวล่าสุดที่เตือนไปแล้ว + ทำเป็น feed
    for (const id of (j.sent || [])) {
      const parts = String(id).split("|");
      const t = Date.parse(parts[0]);
      if (t && t > lastAlertTs) lastAlertTs = t;
      const text = [parts[1], parts[2]].filter(Boolean).join(" ").trim();
      if (text) feed.push({ ts: t || lastTs, text, ok: true });
    }
    feed.sort((a, b) => b.ts - a.ts);
    feed = feed.slice(0, 8);
  } catch (e) { /* ยังไม่เคยรัน */ }

  const age = lastTs ? Date.now() - lastTs : Infinity;
  return {
    ch: "news",
    tier: 2,
    label: "news-alert",
    sub: "เตือนก่อนข่าว 30 นาที",
    // ตั้งรันทุก 15 นาที → เกิน 40 นาทีถือว่าเงียบผิดปกติ
    state: !lastTs ? "armed" : (age < 40 * 60e3 ? "live" : "idle"),
    lastTs,
    lastAlertTs,
    stat: sent ? sent + " ข่าวที่เตือนแล้ว" : "ยังไม่เคยเตือน",
    stat2: lastTs ? "" : "ยังไม่เคยรัน — ตั้ง Scheduled Task ก่อน",
    note: "",
    sent,
    // ⚠️ ทุก source ต้องคืน feed เสมอตามสัญญาใน sources.js บรรทัด 10 —
    // ช่องนี้เคยไม่มี ทำให้ fingerprint() ใน index.js พังทุก tick แล้วหน้าเว็บไม่อัปเดตสดเลย
    feed,
  };
}

module.exports = {
  readCodex,
  readNewsAlert,
  readAntigravityDeep,
  readVscodeAI,
  readCopilotCli,
  readMcp,
  readBrowserAutomation,
  readBrain,
};

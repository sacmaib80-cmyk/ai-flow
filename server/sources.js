"use strict";
/**
 * sources.js — อ่าน "สัญญาณ" จากทุกช่องทางในเครื่อง
 *
 * กฎของไฟล์นี้: อ่านอย่างเดียว ห้ามเขียนทับของจริงเด็ดขาด
 *  - sqlite: copy ออกมาก่อนแล้วค่อยเปิด (กันชน WAL ของ gateway ที่รันอยู่)
 *  - jsonl : อ่านเฉพาะท้ายไฟล์ (บางไฟล์ 27MB อ่านทั้งไฟล์ = ค้าง)
 *
 * ทุก source คืนรูปแบบเดียวกัน:
 *   { ch, state, stat, lastTs, feed:[{ts,text}] }
 *   ch    = claude|gateway|telegram|anti|cron|tasks
 *   state = live|idle|dead   (คำนวณจาก lastTs เทียบ threshold ต่อ channel)
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { EDGES, NODES, computeFlow } = require("./topology.js");
const extra = require("./sources-extra.js");
const health = require("./health.js");

const HOME = os.homedir();
const CLAUDE_PROJECTS = path.join(HOME, ".claude", "projects");
const OPENCLAW = path.join(HOME, ".openclaw");
const OC_SQLITE = path.join(OPENCLAW, "state", "openclaw.sqlite");
const ANTI_SCRATCH = path.join(HOME, ".gemini", "antigravity", "scratch");

/**
 * เงียบเกินเท่าไหร่ถือว่า idle / dead (ms)
 *
 * ⚠️ บทเรียนตอนเทสรอบแรก: cron ตั้ง idle=26h เพราะมันรันวันละครั้ง
 * ผลคือ job ที่รันไปแล้ว 8 ชั่วโมงยังโชว์ "LIVE" ทั้งที่ตัวเลขข้างๆ บอก 8 ชม.
 * = หน้าจอโกหก User. แก้เป็น: "live" แปลว่า *เพิ่งมีสัญญาณจริงๆ* เท่านั้น
 * ส่วนงานที่รันเป็นรอบ ใช้ `armed` (ตั้งเวลาไว้ รอรอบถัดไป) แทน — ดู stateFor
 */
const THRESH = {
  claude:   { idle: 3 * 60e3,  dead: 45 * 60e3 },
  gateway:  { idle: 10 * 60e3, dead: 6 * 3600e3 },
  telegram: { idle: 30 * 60e3, dead: 24 * 3600e3 },
  anti:     { idle: 15 * 60e3, dead: 12 * 3600e3 },
  cron:     { idle: 90 * 60e3, dead: 3 * 24 * 3600e3 },
  tasks:    { idle: 90 * 60e3, dead: 7 * 24 * 3600e3 },
};

/**
 * สถานะของสาย:
 *   live  = มีสัญญาณสดๆ (เพิ่งวิ่ง)
 *   armed = ยังตั้งอยู่/พร้อมทำงาน แต่ตอนนี้ไม่มีอะไรวิ่ง (เช่น cron รอรอบถัดไป)
 *   idle  = เงียบผิดปกติ
 *   dead  = ปิดอยู่ / พังไปแล้ว / ไม่มีข้อมูล
 * opts: { forcedDead, armed, lastOk }
 */
function stateFor(ch, lastTs, opts) {
  opts = opts || {};
  if (opts.forcedDead) return "dead";
  if (!lastTs) return opts.armed ? "armed" : "dead";
  const age = Date.now() - lastTs;
  const t = THRESH[ch] || THRESH.claude;
  if (age > t.dead) return opts.armed ? "armed" : "dead";
  if (age <= t.idle) return opts.lastOk === false ? "idle" : "live";
  // เงียบเกิน idle: ถ้าเป็นงานตั้งเวลาที่ยังเปิดอยู่ = armed ไม่ใช่ตาย
  return opts.armed ? "armed" : "idle";
}

/* ---------------------------------------------------------------- utils */

/** อ่าน N ไบต์ท้ายไฟล์ แล้วคืนบรรทัดที่ parse ได้ (ไฟล์ jsonl ใหญ่มาก ห้ามอ่านทั้งไฟล์) */
function tailLines(file, bytes = 512 * 1024) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - bytes);
    const len = size - start;
    if (len <= 0) return [];
    const buf = Buffer.allocUnsafe(len);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, start);
    const text = buf.toString("utf8");
    // ถ้าไม่ได้เริ่มที่หัวไฟล์ บรรทัดแรกมักขาดครึ่ง ตัดทิ้ง
    const lines = text.split("\n");
    if (start > 0) lines.shift();
    return lines.filter((l) => l.trim());
  } catch (e) {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

function shorten(s, n = 110) {
  if (!s) return "";
  s = String(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/* --------------------------------------------------- 1) Claude Code */

/**
 * อ่าน transcript ของ Claude Code
 * โครงจริงที่ verify มาแล้ว: บรรทัดละ 1 JSON, มี .type, .timestamp,
 * และ assistant turn มี message.content[] ที่มี block type "tool_use" (.name)
 */
function readClaude() {
  const feed = [];
  let lastTs = 0;
  let sessions = 0;
  const toolCount = {};
  let cwdSeen = null;

  let projectDirs = [];
  try {
    projectDirs = fs.readdirSync(CLAUDE_PROJECTS)
      .map((d) => path.join(CLAUDE_PROJECTS, d))
      .filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } });
  } catch (_) { return emptyCh("claude", "ไม่พบโฟลเดอร์ transcript"); }

  // รวมทุก project เอาเฉพาะไฟล์ที่ถูกแตะล่าสุด (คุยกันจริงช่วงนี้)
  const files = [];
  for (const dir of projectDirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { continue; }
    for (const n of names) {
      if (!n.endsWith(".jsonl")) continue;
      const f = path.join(dir, n);
      try {
        const st = fs.statSync(f);
        files.push({ f, mtime: st.mtimeMs, project: path.basename(dir) });
      } catch (_) {}
    }
  }
  sessions = files.length;
  files.sort((a, b) => b.mtime - a.mtime);

  // ดูละเอียดเฉพาะ 4 ไฟล์ล่าสุดพอ (ที่เหลือแค่นับจำนวน)
  for (const { f, project } of files.slice(0, 4)) {
    for (const line of tailLines(f)) {
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      const ts = j.timestamp ? Date.parse(j.timestamp) : 0;
      if (ts && ts > lastTs) lastTs = ts;
      if (j.cwd && !cwdSeen) cwdSeen = j.cwd;

      const c = j.message && j.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== "tool_use") continue;
          toolCount[b.name] = (toolCount[b.name] || 0) + 1;
          let detail = "";
          const inp = b.input || {};
          if (inp.file_path) detail = path.basename(String(inp.file_path));
          else if (inp.command) detail = shorten(inp.command, 60);
          else if (inp.pattern) detail = shorten(inp.pattern, 40);
          else if (inp.skill) detail = String(inp.skill);
          else if (inp.description) detail = shorten(inp.description, 50);
          if (ts) feed.push({ ts, text: `${b.name}${detail ? " · " + detail : ""}`, meta: project });
        }
      }
    }
  }

  feed.sort((a, b) => b.ts - a.ts);
  const topTools = Object.entries(toolCount).sort((a, b) => b[1] - a[1]).slice(0, 3)
    .map(([k, v]) => `${k}×${v}`).join("  ");

  return {
    ch: "claude",
    label: "Claude Code",
    sub: cwdSeen ? path.basename(cwdSeen) : "d:\\git",
    state: stateFor("claude", lastTs),
    lastTs,
    stat: `${sessions} session`,
    stat2: topTools || "ไม่มี tool ล่าสุด",
    feed: feed.slice(0, 8),
  };
}

/* ------------------------------------- 2+3+5) OpenClaw sqlite (gateway/telegram/cron) */

/** copy sqlite (+wal/shm) ไป temp แล้วเปิดอ่าน — ห้ามเปิดตัวจริงตรงๆ */
function withOpenclawDb(tmpDir, fn) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require("node:sqlite")); }
  catch (_) { return null; } // node เก่ากว่า 22 → ไม่มี built-in sqlite
  if (!fs.existsSync(OC_SQLITE)) return null;

  const tmp = path.join(tmpDir, "oc-snapshot.sqlite");
  try {
    for (const ext of ["", "-wal", "-shm"]) {
      try { fs.copyFileSync(OC_SQLITE + ext, tmp + ext); } catch (_) {}
    }
    const db = new DatabaseSync(tmp); // ไม่ readOnly เพราะต้องให้มัน replay WAL ได้
    try { return fn(db); } finally { try { db.close(); } catch (_) {} }
  } catch (e) {
    return null;
  }
}

function readOpenclaw(tmpDir) {
  const out = withOpenclawDb(tmpDir, (db) => {
    const res = {};

    // ---- cron: job + ประวัติการรันจริง
    let jobs = [];
    try { jobs = db.prepare("SELECT * FROM cron_jobs").all(); } catch (_) {}
    let runs = [];
    try {
      runs = db.prepare("SELECT job_id, ts, status, error FROM cron_run_logs ORDER BY ts DESC LIMIT 40").all();
    } catch (_) {}

    const jobName = new Map(jobs.map((j) => [j.job_id, j.name]));
    const cronFeed = runs.map((r) => ({
      ts: Number(r.ts) || 0,
      text: `${jobName.get(r.job_id) || "job"} · ${r.status}${r.error ? " · " + shorten(r.error, 40) : ""}`,
      ok: r.status === "ok",
    }));
    const cronLast = cronFeed.length ? cronFeed[0].ts : 0;
    const okCount = cronFeed.filter((f) => f.ok).length;
    const enabled = jobs.filter((j) => j.enabled).length;

    // สุขภาพของสายนี้ดูจาก "รอบล่าสุดสำเร็จไหม" ไม่ใช่แค่ว่ารันมานานแค่ไหน
    const lastOk = cronFeed.length ? cronFeed[0].ok : undefined;

    res.cron = {
      ch: "cron",
      label: "Cron / ตารางเวลา",
      sub: jobs.length ? shorten(jobs[0].name, 34) : "ไม่มี job",
      state: stateFor("cron", cronLast, { forcedDead: enabled === 0, armed: enabled > 0, lastOk }),
      lastTs: cronLast,
      stat: `${enabled} job เปิดอยู่`,
      stat2: cronFeed.length
        ? `รัน ${cronFeed.length} ครั้ง · สำเร็จ ${okCount}${lastOk === false ? " · รอบล่าสุดพลาด" : ""}`
        : "ยังไม่เคยรัน",
      feed: cronFeed.slice(0, 8),
      schedule: jobs.length ? `${jobs[0].schedule_expr || ""} ${jobs[0].schedule_tz || ""}`.trim() : "",
    };

    // ---- gateway: มีชีวิตไหม ดูจาก task_runs + delivery + ไฟล์ log
    let taskRuns = [];
    try {
      taskRuns = db.prepare(
        "SELECT runtime, agent_id, child_session_key, rowid FROM task_runs ORDER BY rowid DESC LIMIT 10"
      ).all();
    } catch (_) {}
    let deliveries = [];
    try {
      deliveries = db.prepare("SELECT * FROM delivery_queue_entries ORDER BY rowid DESC LIMIT 10").all();
    } catch (_) {}

    res._taskRuns = taskRuns;
    res._deliveries = deliveries;

    // ---- ข้อมูลดิบสำหรับคำนวณ "การไหล" ต่อเส้น (topology.js ใช้)
    res._raw = {
      cronRuns: runs.map((r) => ({
        ts: Number(r.ts) || 0,
        ok: r.status === "ok",
        name: jobName.get(r.job_id) || "cron job",
      })),
      // ⚠️ ชื่อคอลัมน์จริงคือ enqueued_at / updated_at / failed_at
      // (เดาเป็น created_at_ms ตอนแรก → ได้ undefined → ts=0 → เส้น gateway>telegram
      //  เงียบตลอดทั้งที่มี delivery จริง 4 รายการ)
      deliveries: deliveries.map((d) => ({
        ts: Number(d.updated_at || d.failed_at || d.last_attempt_at || d.enqueued_at || 0),
        channel: d.channel || "",
        target: d.target || "",
        status: d.status || "",
        error: d.last_error || "",
        ok: !/fail|error/i.test(String(d.status || "")),
      })),
    };
    return res;
  });

  return out;
}

/* ---------------------------------------------------- gateway (process + log) */

function readGateway(ocData) {
  const feed = [];
  let lastTs = 0;

  // gateway-restart.log = หลักฐานว่ามันเคยขึ้นเมื่อไหร่
  const logf = path.join(OPENCLAW, "logs", "gateway-restart.log");
  try {
    const st = fs.statSync(logf);
    lastTs = Math.max(lastTs, st.mtimeMs);
    const txt = fs.readFileSync(logf, "utf8").trim().split("\n").slice(-6);
    for (const l of txt) if (l.trim()) feed.push({ ts: st.mtimeMs, text: shorten(l, 90) });
  } catch (_) {}

  // config audit = คนแก้ config ล่าสุดเมื่อไหร่
  const auditf = path.join(OPENCLAW, "logs", "config-audit.jsonl");
  try {
    const st = fs.statSync(auditf);
    lastTs = Math.max(lastTs, st.mtimeMs);
  } catch (_) {}

  // sqlite ถูกแตะล่าสุดเมื่อไหร่ = สัญญาณชีพที่แม่นสุด (gateway เขียนตลอด)
  try {
    const st = fs.statSync(OC_SQLITE + "-wal");
    lastTs = Math.max(lastTs, st.mtimeMs);
  } catch (_) {
    try { lastTs = Math.max(lastTs, fs.statSync(OC_SQLITE).mtimeMs); } catch (_) {}
  }

  const runs = (ocData && ocData._taskRuns) || [];
  for (const r of runs.slice(0, 4)) {
    feed.push({ ts: lastTs, text: `task · ${r.runtime || "?"} · agent ${r.agent_id || "?"}` });
  }

  return {
    ch: "gateway",
    label: "OpenClaw Gateway",
    sub: "127.0.0.1:18789",
    // gateway ตั้งเป็น service ไว้ = ถึงเงียบก็ยังถือว่าพร้อมทำงาน (armed) ไม่ใช่ตาย
    state: stateFor("gateway", lastTs, { armed: true }),
    lastTs,
    stat: runs.length ? `${runs.length} task run` : "ไม่มี task",
    stat2: "โหมด local · token auth",
    feed: feed.slice(0, 8),
  };
}

/* ---------------------------------------------------- telegram */

function readTelegram(ocData, cfg) {
  const feed = [];
  let lastTs = 0;

  const tg = cfg && cfg.channels && cfg.channels.telegram;
  const enabled = !!(tg && tg.enabled);
  const owners = (cfg && cfg.commands && cfg.commands.ownerAllowFrom) || [];

  // การส่งออกล่าสุด = หลักฐานว่าสายนี้ยังส่งของได้จริง
  const dels = (ocData && ocData._deliveries) || [];
  let failed = 0;
  for (const d of dels) {
    // ชื่อคอลัมน์จริงของ delivery_queue_entries (ดู comment ใน readOpenclaw)
    const ts = Number(d.updated_at || d.failed_at || d.last_attempt_at || d.enqueued_at || 0);
    if (ts > lastTs) lastTs = ts;
    const bad = /fail|error/i.test(String(d.status || ""));
    if (bad) failed++;
    const why = bad && d.last_error ? " · " + shorten(d.last_error, 40) : "";
    feed.push({ ts, text: shorten(`${d.status || "queued"} · ${d.channel || "telegram"}${why}`, 90), ok: !bad });
  }

  // cron ที่ยิงเข้า telegram ก็นับเป็นสัญญาณของสายนี้
  if (ocData && ocData.cron && ocData.cron.lastTs > lastTs) {
    lastTs = ocData.cron.lastTs;
    feed.push({ ts: lastTs, text: "cron ส่งข้อความผ่านสายนี้", ok: true });
  }
  feed.sort((a, b) => b.ts - a.ts);

  return {
    ch: "telegram",
    label: "Telegram Bot",
    sub: "@sacmaib_claw_bot",
    // เปิดอยู่ = armed เสมอ (บอทรอรับข้อความได้ ถึงจะไม่มีใครทักมานาน)
    state: stateFor("telegram", lastTs, { forcedDead: !enabled, armed: enabled }),
    lastTs,
    stat: enabled ? "เปิดใช้งาน" : "ปิดอยู่",
    stat2: owners.length ? `owner: ${owners[0]}` : "ยังไม่จับคู่",
    // คิวที่ค้าง fail เป็นของเก่า ไม่ใช่สถานะปัจจุบัน — บอกแยกไม่ให้เข้าใจผิดว่าบอทพัง
    note: failed ? `มีคิวค้างพลาด ${failed} รายการ (ของเก่า)` : "",
    feed: feed.slice(0, 8),
  };
}

/* ---------------------------------------------------- 4) Antigravity */

function readAnti() {
  const feed = [];
  let lastTs = 0;
  let files = 0;

  // สแกนแค่ชั้นบน + โฟลเดอร์โปรเจกต์ร่วม (scratch มีไฟล์เป็นพัน อย่าไล่ทั้งหมด)
  const interesting = [];
  try {
    for (const n of fs.readdirSync(ANTI_SCRATCH)) {
      const p = path.join(ANTI_SCRATCH, n);
      try {
        const st = fs.statSync(p);
        files++;
        if (st.isFile()) interesting.push({ p, n, m: st.mtimeMs });
        else if (st.isDirectory()) {
          // ดูไฟล์สื่อสารในโปรเจกต์ร่วม
          for (const sub of ["TEAM_CHAT.md", "PROJECT_BOARD.md", "theme.css"]) {
            const sp = path.join(p, sub);
            try { interesting.push({ p: sp, n: `${n}/${sub}`, m: fs.statSync(sp).mtimeMs }); } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {
    return emptyCh("anti", "ไม่พบโฟลเดอร์ Antigravity");
  }

  // รวมโปรเจกต์ร่วมที่ทำอยู่ด้วย — อ้างจากที่ตั้งไฟล์นี้เอง (__dirname)
  // ⚠️ อย่า hardcode path เต็ม: เคยเขียน "D:\git\ai-flow" ตรงๆ แล้วพอย้ายโฟลเดอร์
  // ไป automation-tools/ สายนี้กลายเป็น dead ทันทีเพราะหาไฟล์ไม่เจอ
  const projRoot = path.join(__dirname, "..");
  const projName = path.basename(projRoot);
  for (const sub of ["TEAM_CHAT.md", "PROJECT_BOARD.md", path.join("web", "theme.css")]) {
    const sp = path.join(projRoot, sub);
    try {
      interesting.push({ p: sp, n: `${projName}/${sub.replace(/\\/g, "/")}`, m: fs.statSync(sp).mtimeMs });
    } catch (_) {}
  }

  interesting.sort((a, b) => b.m - a.m);
  for (const it of interesting.slice(0, 8)) {
    if (it.m > lastTs) lastTs = it.m;
    feed.push({ ts: it.m, text: shorten(it.n, 60) });
  }

  return {
    ch: "anti",
    label: "Antigravity (Gemini)",
    sub: "scratch workspace",
    state: stateFor("anti", lastTs),
    lastTs,
    stat: `${files} รายการ`,
    stat2: "ทำงานผ่านไฟล์ร่วม",
    feed: feed.slice(0, 8),
  };
}

/* ---------------------------------------------------- 6) Scheduled Tasks */

let _tasksCache = { ts: 0, data: null };

/** schtasks ช้า (~1s) เลย cache ไว้ 60 วิ และเรียกแบบ async */
function readTasks(cb) {
  const now = Date.now();
  if (_tasksCache.data && now - _tasksCache.ts < 60e3) return cb(_tasksCache.data);

  const fallback = () => {
    const d = emptyCh("tasks", "อ่านไม่ได้");
    d.label = "Scheduled Tasks";
    cb(d);
  };

  execFile("schtasks", ["/query", "/fo", "csv", "/v"], { maxBuffer: 12e6, windowsHide: true },
    (err, stdout) => {
      if (err || !stdout) return fallback();
      const lines = stdout.split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return fallback();

      const head = splitCsv(lines[0]);
      const iName = head.findIndex((h) => /TaskName/i.test(h));
      const iNext = head.findIndex((h) => /Next Run Time/i.test(h));
      const iLast = head.findIndex((h) => /Last Run Time/i.test(h));
      const iStat = head.findIndex((h) => /^Status$/i.test(h));
      const iRes  = head.findIndex((h) => /Last Result/i.test(h));

      // ตัด task ของ Windows/ผู้ผลิตซอฟต์แวร์ออก — เราสนใจ "automation ที่ User ตั้งเอง"
      // (รอบแรกกรองไม่พอ เหลือ Opera/BlueStacks/Meta ปนมา ทำให้ขึ้น "119 task" ซึ่งไม่ใช่ของ User)
      const NOISE = new RegExp([
        "\\\\Microsoft\\\\", "\\\\Meta\\\\",
        "Adobe", "Google", "Mozilla", "Edge", "OneDrive", "NVIDIA", "Intel",
        "Dropbox", "CCleaner", "Opera", "Brave", "klcp", "BlueStacks",
        "Messenger", "Autoupdate", "Update Task", "Updater",
        "speed launcher", "Overwolf", "Razer", "Steam", "Epic",
      ].join("|"), "i");
      const seen = new Set();
      const mine = [];
      for (const line of lines.slice(1)) {
        const c = splitCsv(line);
        const name = (c[iName] || "").trim();
        if (!name || NOISE.test(name)) continue;
        // schtasks /v แทรกแถว header ซ้ำระหว่างกลุ่ม → กันไม่ให้กลายเป็น task ชื่อ "TaskName"
        if (name === "TaskName" || /^Last Result$/i.test((c[iRes] || "").trim())) continue;
        if (seen.has(name)) continue; // /v ให้หลายแถวต่อ task (trigger ละแถว)
        seen.add(name);
        mine.push({
          name: name.replace(/^\\/, ""),
          next: (c[iNext] || "").trim(),
          last: (c[iLast] || "").trim(),
          status: (c[iStat] || "").trim(),
          result: (c[iRes] || "").trim(),
        });
      }

      let lastTs = 0;
      const feed = [];
      for (const t of mine) {
        const ts = parseTaskTime(t.last);
        if (ts > lastTs) lastTs = ts;
        const ok = t.result === "0" || /^0$/.test(t.result);
        feed.push({
          ts,
          text: `${shorten(t.name, 40)} · ${ok ? "ok" : (t.result ? "code " + t.result : t.status || "?")}`,
          ok,
        });
      }
      feed.sort((a, b) => b.ts - a.ts);

      const ready = mine.filter((t) => /ready|running/i.test(t.status)).length;

      const data = {
        ch: "tasks",
        label: "Scheduled Tasks",
        sub: "Windows Task Scheduler",
        // task ที่ Ready = ตั้งไว้รอทำงาน (armed) ไม่ใช่ตาย
        state: stateFor("tasks", lastTs, { forcedDead: mine.length === 0, armed: ready > 0 }),
        lastTs,
        stat: `${mine.length} task ของคุณ`,
        stat2: mine.length ? `พร้อมทำงาน ${ready}` : "ไม่มี task ของผู้ใช้",
        feed: feed.slice(0, 8),
        // ดิบไว้ให้ topology หา task ที่ยิง Telegram ตรง (sale-alert)
        runs: mine.map((t) => ({
          name: t.name,
          ts: parseTaskTime(t.last),
          ok: t.result === "0",
        })),
      };
      _tasksCache = { ts: now, data };
      cb(data);
    });
}

/**
 * แปลงเวลาที่ schtasks คืนมา — เครื่องนี้ตั้ง locale ไทย ได้รูปแบบ:
 *     "28/7/2569 14:54:30"   =  วัน/เดือน/ปี พ.ศ. เวลา 24 ชม.
 *
 * ⚠️ 3 กับดักที่เจอจริงตอนเทส (อย่าลบ comment นี้):
 *  1. **วันมาก่อนเดือน** (D/M/Y) ไม่ใช่ M/D/Y แบบอเมริกา → 28/7 ไม่ใช่เดือน 28
 *  2. **ปีเป็น พ.ศ.** (2569) → ถ้าไม่ลบ 543 จะได้ ค.ศ.2569 = อนาคต
 *     ทำให้ age ติดลบ (บั๊กที่เห็นเป็น age=-17188846929s)
 *  3. **"30/11/2542" = ค่า sentinel ของ Windows** แปลว่า "ไม่เคยรัน"
 *     (= 30/11/1999 ค.ศ.) ไม่ใช่เวลาจริง ต้องคืน 0
 * Date.parse เดิมคืน NaN กับรูปแบบนี้ → ทุก task เลยกลายเป็น age=never
 */
function parseTaskTime(s) {
  if (!s) return 0;
  s = String(s).trim();
  if (/^(N\/A|Never|ไม่)/i.test(s)) return 0;

  const m = s.match(/(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})[,\s]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?/i);
  if (!m) { const d = Date.parse(s); return isNaN(d) ? 0 : d; }

  let [, p1, p2, p3, hh, mm, ss, ap] = m;
  p1 = +p1; p2 = +p2; p3 = +p3; hh = +hh; mm = +mm; ss = +(ss || 0);

  let y, mo, d;
  if (p1 > 31) { y = p1; mo = p2; d = p3; }        // Y/M/D
  else if (p1 > 12) { d = p1; mo = p2; y = p3; }   // D/M/Y (วันเกิน 12 = ชัดเจน)
  else { d = p1; mo = p2; y = p3; }                // locale ไทย = D/M/Y เป็นหลัก
  if (y < 100) y += 2000;
  if (y > 2400) y -= 543;                          // พ.ศ. → ค.ศ.

  if (ap) { const u = ap.toUpperCase(); if (u === "PM" && hh < 12) hh += 12; if (u === "AM" && hh === 12) hh = 0; }

  const t = new Date(y, mo - 1, d, hh, mm, ss).getTime();
  if (isNaN(t)) return 0;
  if (t < Date.parse("2001-01-01")) return 0;      // sentinel "ไม่เคยรัน"
  if (t > Date.now() + 36e5) return 0;             // อนาคตเกิน 1 ชม. = พาร์สเพี้ยน
  return t;
}

function splitCsv(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q; }
    else if (c === "," && !q) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/* ---------------------------------------------------- helpers */

function emptyCh(ch, why) {
  return {
    ch, label: ch, sub: why || "",
    state: "dead", lastTs: 0,
    stat: "ไม่มีข้อมูล", stat2: why || "", feed: [],
  };
}

function readConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(OPENCLAW, "openclaw.json"), "utf8")); }
  catch (_) { return null; }
}

/** เก็บทุกสายในทีเดียว (async เพราะ schtasks) */
function collectAll(tmpDir, cb) {
  const cfg = readConfig();
  const oc = readOpenclaw(tmpDir) || {};

  // tier 1 = agent เต็มตัว · tier 2 = ผู้ช่วยในเครื่องมือ · tier 3 = ท่อ/ทางเชื่อม
  // (ผัง+CSS ใช้ tier ตัดสินน้ำหนักการแสดงผล — ตัวใหญ่เด่น ตัวรองเบาลง)
  const channels = [
    Object.assign(readClaude(), { tier: 1 }),
    Object.assign(readGateway(oc), { tier: 1 }),
    extra.readCodex(),                                   // ← ตกสำรวจรอบแรก
    extra.readAntigravityDeep(),                         // ← แทน readAnti() เดิม (ลึกกว่า)
    Object.assign(oc.cron || emptyCh("cron", "อ่าน sqlite ไม่ได้"), { tier: 2 }),
    Object.assign(readTelegram(oc, cfg), { tier: 3 }),
    extra.readVscodeAI(),
    extra.readCopilotCli(),
    extra.readMcp(),
    extra.readBrowserAutomation(),
    extra.readBrain(),          // ← สมองกลางที่ทุกตัวแชร์ความรู้กัน
    extra.readNewsAlert(),      // ← สายข่าวเศรษฐกิจ → Telegram
  ];

  readTasks((tasks) => {
    channels.push(Object.assign(tasks, { tier: 2 }));
    // timeline รวมทุกสาย
    const tape = [];
    for (const c of channels) {
      for (const f of c.feed || []) {
        if (f.ts) tape.push({ ts: f.ts, ch: c.ch, text: f.text });
      }
    }
    tape.sort((a, b) => b.ts - a.ts);

    // ---- คำนวณ "การไหลจริง" ต่อเส้นทาง
    const byCh = {};
    channels.forEach((c) => { byCh[c.ch] = c; });
    const claudeCh = byCh.claude || {}, antiCh = byCh.anti || {};
    const pick = (id) => byCh[id] || {};
    const codexCh = pick("codex"), vsCh = pick("vscode"),
          mcpCh = pick("mcp"), cpCh = pick("copilot"), brCh = pick("browser");

    const flow = computeFlow({
      cronRuns: (oc._raw && oc._raw.cronRuns) || [],
      deliveries: (oc._raw && oc._raw.deliveries) || [],
      taskRuns: tasks.runs || [],
      claudeLastTs: claudeCh.lastTs,
      claudeLastText: (claudeCh.feed && claudeCh.feed[0] || {}).text,
      antiLastTs: antiCh.lastTs,
      antiLastText: (antiCh.feed && antiCh.feed[0] || {}).text,
      codexLastTs: codexCh.lastTs,
      codexLastText: (codexCh.feed && codexCh.feed[0] || {}).text,
      vscodeLastTs: vsCh.lastTs,
      mcpLastTs: mcpCh.lastTs,
      mcpName: mcpCh.stat2,
      copilotLastTs: cpCh.lastTs,
      browserLastTs: brCh.lastTs,
      brainLastTs: pick("brain").lastTs,
      brainWired: pick("brain").wired || [],
      newsLastTs: pick("news").lastTs,
      newsLastAlertTs: pick("news").lastAlertTs,
      newsLastAlertName: pick("news").stat,
    });

    // รวม error ทุกสาย + สุขภาพเครื่อง (vitals ช้ากว่า → มี cache 60 วิในตัว)
    let errors = { items: [], total: 0, recent: 0 };
    try { errors = health.collectErrors(oc._raw, tasks.runs); } catch (_) {}

    health.collectVitals((vitals) => {
      health.collectRunning((running) => {
        cb({
          now: Date.now(),
          host: os.hostname(),
          channels,
          nodes: NODES,
          edges: EDGES,
          flow,
          tape: tape.slice(0, 40),
          errors,
          vitals,
          running,
        });
      });
    });
  });
}

module.exports = { collectAll, readClaude, readAnti, THRESH };

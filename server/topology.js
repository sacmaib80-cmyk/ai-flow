"use strict";
/**
 * topology.js — "เส้นทางจริง" ของงานที่วิ่งในเครื่อง
 *
 * ⚠️ หลักการสำคัญ: เส้นในแอปนี้ต้องเป็น **ข้อมูล ไม่ใช่การตกแต่ง**
 * เดิมวาดเป็นล้อจักรยาน (ทุกสายวิ่งเข้า hub) ซึ่ง *ดูดี แต่โกหก* —
 * มันไม่ได้บอกว่าใครสั่งใคร User เลยดูไม่ออกว่างานไหลไปทางไหน
 *
 * เส้นทางข้างล่างนี้ **พิสูจน์จากข้อมูลจริงใน sqlite** ไม่ได้เดา:
 *   cron_jobs.job_id
 *     → task_runs.source_id (runtime='cron', agent_id='main')
 *       → task_runs.child_session_key = "agent:main:cron:<job>:run:<ts>"
 *         → delivery_queue_entries.session_key (คีย์เดียวกัน)
 *           → channel='telegram', target='telegram:8253517031'
 * = cron → gateway → telegram  (มีหลักฐานทุกช่วง)
 *
 * ส่วนที่ยังไม่มีหลักฐานใน DB จะ mark ว่า inferred:true (เช่น gateway→claude-cli
 * ที่รู้จาก config ว่า model = "claude-cli/..." แต่ไม่มีตาราง log ของช่วงนี้)
 */

/**
 * นิยามเส้นทาง: from → to
 *  kind   : 'trigger' (จุดชนวน) | 'work' (ประมวลผล) | 'deliver' (ส่งออก) | 'file' (คุยผ่านไฟล์)
 *  label  : ข้อความอธิบายเส้นนี้ (ภาษาไทย)
 *  inferred: true = รู้จาก config/สถาปัตยกรรม แต่ยังไม่มี log ยืนยันรายครั้ง
 */
const EDGES = [
  {
    id: "cron>gateway",
    from: "cron", to: "gateway", kind: "trigger",
    label: "cron จุดชนวนงานตามเวลา",
  },
  {
    id: "gateway>claude",
    from: "gateway", to: "claudecli", kind: "work",
    label: "gateway เรียกโมเดลผ่าน claude-cli",
    inferred: true,
  },
  {
    id: "claude>gateway",
    from: "claudecli", to: "gateway", kind: "work",
    label: "โมเดลตอบกลับ",
    inferred: true,
  },
  {
    id: "gateway>telegram",
    from: "gateway", to: "telegram", kind: "deliver",
    label: "gateway ส่งข้อความออก",
  },
  {
    id: "telegram>you",
    from: "telegram", to: "you", kind: "deliver",
    label: "เข้ามือถือคุณ",
  },
  {
    id: "you>telegram",
    from: "you", to: "telegram", kind: "trigger",
    label: "คุณพิมพ์สั่งบอท",
    inferred: true,
  },
  {
    // สายนี้ไม่ผ่าน gateway เลย — ยิงเข้า Bot API ตรงๆ (sale-alert.js)
    id: "tasks>telegram",
    from: "tasks", to: "telegram", kind: "deliver",
    label: "Scheduled Task ยิงเข้า Bot API ตรง (ไม่ผ่าน gateway)",
  },
  {
    // ปฏิทินข่าวเศรษฐกิจ (ForexFactory public feed) → news-alert.js
    id: "ffcal>news",
    from: "ffcal", to: "news", kind: "trigger",
    label: "ดึงปฏิทินข่าวจาก feed สาธารณะ",
  },
  {
    id: "news>telegram",
    from: "news", to: "telegram", kind: "deliver",
    label: "เตือนก่อนข่าวสำคัญ → Bot API ตรง (ไม่กินโควตา)",
  },
  {
    id: "claudecode>repo",
    from: "claude", to: "repo", kind: "file",
    label: "Claude Code เขียนไฟล์",
  },
  {
    id: "repo>anti",
    from: "repo", to: "anti", kind: "file",
    label: "Antigravity อ่าน/เขียนไฟล์เดียวกัน",
  },
  {
    id: "anti>repo",
    from: "anti", to: "repo", kind: "file",
    label: "Antigravity ส่งงานกลับผ่านไฟล์",
  },

  /* ---------- สายที่ตกสำรวจรอบแรก ---------- */
  {
    // Codex เปิดจาก VS Code (source='vscode' ใน threads) แล้วแก้ไฟล์ใน repo
    id: "vscode>codex",
    from: "vscode", to: "codex", kind: "trigger",
    label: "เปิด Codex จาก VS Code",
  },
  {
    id: "codex>repo",
    from: "codex", to: "repo", kind: "file",
    label: "Codex แก้ไฟล์ในโปรเจกต์ (cwd = d:\\git)",
  },
  {
    id: "vscode>claude",
    from: "vscode", to: "claude", kind: "trigger",
    label: "เปิด Claude Code จาก VS Code",
    inferred: true,
  },
  {
    // MCP = ท่อที่ Claude Code ต่อออกไปคุมโปรแกรมอื่น
    id: "claude>mcp",
    from: "claude", to: "mcp", kind: "work",
    label: "Claude เรียกผ่าน MCP",
    inferred: true,
  },
  {
    id: "mcp>studio",
    from: "mcp", to: "studio", kind: "deliver",
    label: "MCP คุม Roblox Studio",
    inferred: true,
  },
  {
    // Copilot CLI = ตัวตรวจงานอิสระ (คนละโมเดล) อ่านไฟล์ใน repo
    id: "copilot>repo",
    from: "copilot", to: "repo", kind: "work",
    label: "Copilot CLI ตรวจงานในโปรเจกต์",
    inferred: true,
  },
  {
    id: "claude>browser",
    from: "claude", to: "browser", kind: "work",
    label: "สั่ง puppeteer ผ่านสคริปต์",
    inferred: true,
  },
  {
    id: "browser>web",
    from: "browser", to: "web", kind: "deliver",
    label: "ยิงขึ้นเว็บภายนอก (Gumroad/Pinterest)",
  },

  /* ---------- BRAIN: สมองกลางป้อนความรู้ให้ทุกตัว ----------
     ทิศทาง brain → AI = "ความรู้ไหลเข้าหัวมัน"
     เส้นพวกนี้ "ต่ออยู่จริง" ก็ต่อเมื่อไฟล์ทางเข้าของตัวนั้นยังชี้มาที่ .brain
     (ถ้าใครลบลิงก์ทิ้ง เส้นจะกลายเป็น never ทันที = เห็นได้ด้วยตา) */
  {
    id: "brain>claude",
    from: "brain", to: "claude", kind: "knowledge",
    label: "Claude อ่านผ่าน CLAUDE.md",
  },
  {
    id: "brain>codex",
    from: "brain", to: "codex", kind: "knowledge",
    label: "Codex อ่านผ่าน AGENTS.md",
  },
  {
    id: "brain>gateway",
    from: "brain", to: "gateway", kind: "knowledge",
    label: "OpenClaw อ่านผ่าน workspace/MEMORY.md",
  },
  {
    id: "brain>anti",
    from: "brain", to: "anti", kind: "knowledge",
    label: "Antigravity ต้องใส่ path ในบรีฟเอง (อ่านอัตโนมัติไม่ได้)",
    inferred: true,
  },
];

/** โหนดทั้งหมดบนผัง (รวมโหนดที่ไม่ใช่ "สาย" เช่น repo / you) */
const NODES = [
  { id: "cron",      kind: "channel" },
  { id: "tasks",     kind: "channel" },
  { id: "gateway",   kind: "channel", core: true },
  { id: "claudecli", kind: "worker",  label: "claude-cli", sub: "โมเดลที่ gateway เรียก" },
  { id: "telegram",  kind: "channel" },
  { id: "you",       kind: "sink",    label: "มือถือคุณ",  sub: "Telegram" },
  { id: "claude",    kind: "channel" },
  { id: "repo",      kind: "store",   label: "d:\\git",     sub: "ไฟล์ที่แชร์กัน" },
  { id: "anti",      kind: "channel" },
  // ---- ที่ตกสำรวจรอบแรก ----
  { id: "codex",     kind: "channel" },
  { id: "vscode",    kind: "channel" },
  { id: "copilot",   kind: "channel" },
  { id: "mcp",       kind: "channel" },
  { id: "browser",   kind: "channel" },
  { id: "studio",    kind: "sink",    label: "Roblox Studio", sub: "ปลายทางของ MCP" },
  { id: "web",       kind: "sink",    label: "เว็บภายนอก",   sub: "Gumroad · Pinterest" },
  { id: "brain",     kind: "channel", core: true },
  // ---- สายข่าวเศรษฐกิจ (2026-08-04) ----
  // ffcal = แหล่งข้อมูลภายนอก ไม่ใช่ "สาย" ที่มี channel data → วาดเป็น waypoint
  { id: "ffcal",     kind: "source",  label: "ปฏิทินข่าว",   sub: "ForexFactory (สาธารณะ)" },
  // news = มี channel data จริง (readNewsAlert) → วาดเป็นการ์ด ห้ามใส่ kind ที่ทำให้เป็น waypoint ซ้ำ
  { id: "news",      kind: "channel", label: "news-alert",   sub: "เตือนก่อนข่าว 30 นาที" },
];

/**
 * สร้าง "เหตุการณ์การไหล" จาก snapshot
 * คืน map: edgeId -> { lastTs, ok, count, label }
 * เส้นไหนไม่มีของวิ่งเลย จะไม่มี key (หน้าเว็บจะวาดเป็นเส้นจางไว้)
 */
function computeFlow(raw) {
  const flow = {};
  const bump = (id, ts, ok, note) => {
    if (!ts) return;
    const cur = flow[id];
    if (!cur || ts > cur.lastTs) flow[id] = { lastTs: ts, ok: ok !== false, note: note || "", count: (cur ? cur.count : 0) + 1 };
    else cur.count++;
  };

  // ---- เส้นทาง cron: ใช้ run log จริง (มี status ต่อรอบ)
  for (const r of raw.cronRuns || []) {
    bump("cron>gateway", r.ts, true, r.name);
    // งานที่รันสำเร็จ = โมเดลถูกเรียกจริง
    bump("gateway>claude", r.ts, r.ok, r.name);
    bump("claude>gateway", r.ts, r.ok, r.name);
  }

  // ---- การส่งออกจริง (มี channel/target/status)
  for (const d of raw.deliveries || []) {
    if (!d.ts) continue;
    if (d.channel === "telegram") {
      bump("gateway>telegram", d.ts, d.ok, d.status);
      if (d.ok) bump("telegram>you", d.ts, true, "ส่งถึงแล้ว");
    }
  }

  // ---- Scheduled Task ที่ยิง Telegram ตรง (sale-alert)
  for (const t of raw.taskRuns || []) {
    if (!t.ts) continue;
    if (/sale-?alert|gumroad/i.test(t.name || "")) {
      bump("tasks>telegram", t.ts, t.ok, t.name);
      if (t.ok) bump("telegram>you", t.ts, true, t.name);
    }
  }

  // ---- ไฟล์: Claude Code เขียน / Antigravity แตะ
  if (raw.claudeLastTs) {
    bump("claudecode>repo", raw.claudeLastTs, true, raw.claudeLastText || "แก้ไฟล์");
  }
  if (raw.antiLastTs) {
    bump("anti>repo", raw.antiLastTs, true, raw.antiLastText || "แก้ไฟล์");
    bump("repo>anti", raw.antiLastTs, true, "อ่านไฟล์ร่วม");
  }

  // ---- สายที่เพิ่งเพิ่ม
  if (raw.codexLastTs) {
    // thread ของ Codex มี source='vscode' → เปิดมาจาก VS Code จริง
    bump("vscode>codex", raw.codexLastTs, true, raw.codexLastText || "");
    bump("codex>repo", raw.codexLastTs, true, raw.codexLastText || "แก้ไฟล์");
  }
  if (raw.vscodeLastTs) {
    bump("vscode>claude", raw.vscodeLastTs, true, "ส่วนขยาย Claude Code");
  }
  if (raw.mcpLastTs) {
    bump("claude>mcp", raw.mcpLastTs, true, raw.mcpName || "");
    bump("mcp>studio", raw.mcpLastTs, true, raw.mcpName || "");
  }
  if (raw.copilotLastTs) {
    bump("copilot>repo", raw.copilotLastTs, true, "Copilot CLI");
  }
  if (raw.browserLastTs) {
    bump("claude>browser", raw.browserLastTs, true, "puppeteer");
    bump("browser>web", raw.browserLastTs, true, "Gumroad/Pinterest");
  }

  // ---- BRAIN: เส้นสว่างเฉพาะตัวที่ "ต่ออยู่จริง" (ไฟล์ทางเข้ายังชี้มาที่ .brain)
  // ใครถูกลบลิงก์ทิ้ง → ไม่ bump → เส้นเป็น never = เห็นทันทีว่าสายขาด
  if (raw.brainLastTs) {
    for (const who of raw.brainWired || []) {
      bump("brain>" + who, raw.brainLastTs, true, "ความรู้ร่วม");
    }
    // Antigravity ต้องสั่งเอง — ถือว่า "เคยส่งให้" ถ้ามันขยับไฟล์ในโปรเจกต์ร่วม
    if (raw.antiLastTs) bump("brain>anti", raw.antiLastTs, true, "ส่งผ่านบรีฟ");
  }

  // ---- สายข่าวเศรษฐกิจ: อ่านจาก mtime ของ state file จริง
  // (ไฟล์ถูกเขียนทุกครั้งที่สคริปต์รัน = หลักฐานว่ามันยังทำงานอยู่)
  if (raw.newsLastTs) {
    bump("ffcal>news", raw.newsLastTs, true, "ดึง feed สำเร็จ");
    // เส้นส่งออกสว่างเฉพาะตอนมีข่าวถูกเตือนจริง ไม่ใช่แค่รันเปล่า
    if (raw.newsLastAlertTs) {
      bump("news>telegram", raw.newsLastAlertTs, true, raw.newsLastAlertName || "เตือนข่าว");
    }
  }

  return flow;
}

module.exports = { EDGES, NODES, computeFlow };

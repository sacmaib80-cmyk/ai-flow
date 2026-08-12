"use strict";
/**
 * AI Flow — Skill Patch Bay (ปลั๊กสกิล)
 *
 * แนวคิด: "บังคับให้อ่าน" = ยัดตัวหนังสือของสกิลเข้าไปในสิ่งที่โมเดลอ่านอยู่แล้ว
 *          ไม่ใช่การขอร้องให้มันไปเปิดไฟล์เอง
 *
 * ระดับการบังคับต่อสาย (ตรงไปตรงมา ไม่โม้):
 *   claude      -> hook UserPromptSubmit ยัดเนื้อสกิลเข้า "ทุก prompt"   = harness ยัดให้ โมเดลข้ามไม่ได้
 *   codex       -> บล็อกใน d:\git\AGENTS.md (มันอ่านไฟล์นี้เองทุก session)
 *   openclaw    -> บล็อกใน ~/.openclaw/workspace/MEMORY.md
 *   antigravity -> ไฟล์เดี่ยว ACTIVE_SKILL.md (เนื้อเต็ม) + บรีฟ 1 บรรทัดให้ก๊อป
 *                  (ยังไม่เจอ hook ของมัน — ตัวนี้จึงเสีย 1 คลิก แต่เนื้อยังถึงมือมันครบ)
 *
 * state อยู่ที่ skill-plugs.json ข้างโปรเจกต์ (แก้ด้วยมือก็ได้)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const TH_FILE = path.join(__dirname, "skill-th.js");
let skillTh = require("./skill-th.js");
let thMtime = 0;
try { thMtime = fs.statSync(TH_FILE).mtimeMs; } catch (_) {}

/**
 * โหลดตารางแปลไทยใหม่ถ้าไฟล์ถูกแก้
 * ⚠️ ทำไมต้องมี: `require` แคชโมดูลไว้ในโปรเซส → แก้คำแปลแล้วต้องรีสตาร์ท server
 *    ทั้งชุด ซึ่งเสียเวลาและทำให้เข้าใจผิดว่า "แก้แล้วไม่มีผล" (เจอมาแล้วจริง)
 *    ตอนนี้แก้คำแปลแล้วกด F5 ที่หน้าเว็บพอ
 */
function refreshTh() {
  let m = 0;
  try { m = fs.statSync(TH_FILE).mtimeMs; } catch (_) { return; }
  if (m === thMtime) return;
  try {
    delete require.cache[require.resolve("./skill-th.js")];
    skillTh = require("./skill-th.js");
    thMtime = m;
    skillCache = { at: 0, list: [] };   // บังคับสร้างรายการใหม่
  } catch (e) {
    console.error("[ai-flow] โหลด skill-th.js ใหม่ไม่สำเร็จ (ใช้ของเดิมต่อ):", e.message);
  }
}

const HOME = os.homedir();
const ROOT = path.join(__dirname, "..");
const STATE_FILE = path.join(ROOT, "skill-plugs.json");

const SKILL_ROOT = path.join(HOME, ".claude", "skills");
const CODEX_SKILL_ROOT = path.join(HOME, ".codex", "skills");

const AGENTS_MD = path.join("D:", "git", "AGENTS.md");
const OPENCLAW_MEMORY = path.join(HOME, ".openclaw", "workspace", "MEMORY.md");
const ANTI_ACTIVE = path.join(HOME, ".gemini", "antigravity", "scratch", "ACTIVE_SKILL.md");
const CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");
const HOOK_SCRIPT = path.join(__dirname, "skill-hook.js");

const MARK_START = "<!-- AI-FLOW:SKILL-PLUG:START -->";
const MARK_END = "<!-- AI-FLOW:SKILL-PLUG:END -->";

/**
 * เพดานตัวหนังสือที่ยอมยัดต่อครั้ง
 * เดิมตั้งไว้ 20,000 เพราะกลัวเผา context (ยัดซ้ำทุก prompt = กองสะสม)
 * ตอนนี้ hook ยัดเนื้อเต็ม "ครั้งเดียวต่อ session" แล้วรอบหลังเหลือบรรทัดเตือน
 * → ต้นทุนที่วนซ้ำแทบเป็นศูนย์ เพดานเลยดันขึ้นได้ตามจริง
 * (ตั้งที่ 60,000 ≈ 17k token จ่ายครั้งเดียว = เสียบสกิลใหญ่ 3-4 ตัวพร้อมกันได้)
 */
const INJECT_BUDGET = Number(process.env.AIFLOW_INJECT_BUDGET || 60000);

/**
 * เพดานของ "บรีฟ" แยกจากสกิล — และตั้งต่ำกว่ากันเยอะโดยเจตนา
 * สกิลเปลี่ยนนานๆ ครั้ง (จ่ายครั้งเดียวต่อ session ได้)
 * แต่บรีฟเปลี่ยนวันละหลายรอบ และมันไปนั่งใน AGENTS.md / MEMORY.md
 * ที่ถูกอ่านทุก session → ยาวเมื่อไหร่คือภาษีที่จ่ายทุกครั้งตลอดไป
 */
const BRIEF_BUDGET = Number(process.env.AIFLOW_BRIEF_BUDGET || 4000);
const ROLE_MAX = 400;

const AGENTS = ["claude", "codex", "openclaw", "antigravity"];

/**
 * ป้ายชื่อสาย — ใช้ตอนวาดผังทีมให้ทุกตัวเห็นว่าใครทำอะไร
 *
 * ⚠️ ต้องระบุด้วย **ช่องทาง** ไม่ใช่ชื่อโมเดล (บั๊กจริง 2026-07-31)
 *    OpenClaw รันด้วย backend `claude-cli` = ข้างในมันคือ Claude Code จริงๆ
 *    เดิมป้ายเขียนว่า "Claude Code" กับ "OpenClaw" → OpenClaw อ่านผังแล้ว
 *    **เชื่อว่าตัวเองคือสาย Claude Code** แล้วตอบหน้าที่ของสายนั้นมาเป็นของตัวเอง
 *    (เทสจริง 2 รอบ ผิดซ้ำทั้ง 2 รอบ แม้จะเขียนกำกับว่า "ไม่ได้มอบหมาย" แล้ว)
 */
const AGENT_LABEL = {
  claude: "Claude Code (CLI ในเครื่อง — ที่ user พิมพ์คุยด้วยตรงๆ)",
  codex: "Codex / GPT (CLI ของ OpenAI)",
  openclaw: "OpenClaw (บอทผ่าน Telegram / gateway)",
  antigravity: "Antigravity (IDE ฝั่ง Gemini)",
};

/** ชื่อสั้นสำหรับพาดหัว */
const AGENT_SHORT = {
  claude: "Claude Code",
  codex: "Codex / GPT",
  openclaw: "OpenClaw",
  antigravity: "Antigravity",
};

/* ------------------------------------------------------------------ utils */

function safeRead(file) {
  try { return fs.readFileSync(file, "utf8"); } catch (_) { return null; }
}

/** นอนแบบ sync จริงๆ (ไม่ใช่ busy loop กิน CPU) */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (_) { const end = Date.now() + ms; while (Date.now() < end) {} }
}

/**
 * เขียนไฟล์แบบเขียน tmp แล้ว rename ทับ
 *
 * ⚠️ บั๊กจริงที่เจอ (2026-07-31): บน Windows `renameSync` ทับไฟล์ที่มีอยู่
 *    **ล้มด้วย EPERM/EBUSY ได้เป็นครั้งคราว** ถ้ามีใครถือ handle ไฟล์นั้นอยู่ชั่วขณะ
 *    (antivirus / Windows Search / อีกโปรเซสที่อ่านพร้อมกัน)
 *    อาการที่โผล่: server ตอบ 500 แล้ว state ไม่ถูกบันทึก → ของเก่าค้างเหมือนงานฟื้นกลับมา
 *    ยิ่ง autosave ยิงทุก ~0.9 วิ ยิ่งชนบ่อย
 *    แก้: ลอง rename ซ้ำแบบถอยจังหวะ → ถ้ายังไม่ได้ ยอมเขียนทับตรงๆ
 *         (เสีย atomicity ดีกว่าเสียข้อมูลของ user)
 */
function atomicWrite(file, text) {
  const tmp = file + ".aiflow.tmp";
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, "utf8");

  let lastErr = null;
  for (let i = 0; i < 6; i++) {
    try { fs.renameSync(tmp, file); return; }
    catch (e) {
      lastErr = e;
      if (e.code !== "EPERM" && e.code !== "EBUSY" && e.code !== "EACCES") break;
      sleepSync(12 * (i + 1));
    }
  }
  try {
    fs.writeFileSync(file, text, "utf8");
    try { fs.unlinkSync(tmp); } catch (_) {}
    console.error("[ai-flow] rename ทับไม่ได้ (" + (lastErr && lastErr.code) +
      ") — เขียนทับตรงๆ แทน: " + file);
    return;
  } catch (_) {
    throw lastErr || new Error("เขียน " + file + " ไม่สำเร็จ");
  }
}

/** ตัด frontmatter ออกมาแบบง่ายๆ (สกิลใช้ YAML สามขีดหัวไฟล์) */
function parseFrontmatter(raw) {
  const out = { name: "", description: "" };
  // ⚠️ ต้องแปลง CRLF เป็น LF ก่อน ไม่งั้นบรรทัดสุดท้ายของ frontmatter จะเหลือ \r ค้าง
  // แล้ว regex `(.*)$` แมตช์ไม่ติด (JS ถือว่า \r เป็น line terminator)
  // อาการ: อ่าน name ได้ แต่ description หายไปเฉยๆ เฉพาะไฟล์ที่เซฟแบบ Windows
  const text = String(raw).replace(/\r\n?/g, "\n");
  if (!text.startsWith("---")) return out;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return out;
  const head = text.slice(3, end);
  // description มักยาวหลายบรรทัด -> เก็บจนกว่าจะเจอ key ตัวถัดไป
  let key = null;
  const buf = {};
  for (const line of head.split(/\r?\n/)) {
    const m = line.match(/^([a-zA-Z_-]+):\s?(.*)$/);
    if (m) { key = m[1]; buf[key] = m[2]; }
    else if (key && line.trim()) buf[key] += " " + line.trim();
  }
  out.name = (buf.name || "").replace(/^["']|["']$/g, "").trim();
  out.description = (buf.description || "").replace(/^["']|["']$/g, "").trim();
  return out;
}

/* ------------------------------------------------------------------ list */

let skillCache = { at: 0, list: [] };

/**
 * ที่ที่สกิลอยู่จริงในเครื่องนี้ — ไม่ได้มีแค่ ~/.claude/skills
 *   kind:"parent" = โฟลเดอร์ที่ข้างในเป็นโฟลเดอร์สกิลอีกที
 *   kind:"single" = ตัวโฟลเดอร์นั้นเองคือสกิล (มี SKILL.md อยู่ในนั้นเลย)
 */
const SKILL_ROOTS = [
  { dir: SKILL_ROOT, source: "claude", kind: "parent" },
  { dir: path.join(CODEX_SKILL_ROOT, ".system"), source: "codex", kind: "parent" },
  { dir: path.join("D:", "git", "ai-skill-pack"), source: "repo", kind: "single" },
];

function readSkillAt(dir, id, source) {
  const file = path.join(dir, "SKILL.md");
  const text = safeRead(file);
  if (text == null) return null;
  const fm = parseFrontmatter(text);
  return {
    id,
    name: fm.name || id,
    desc: fm.description || "",
    file,
    source,
    bytes: Buffer.byteLength(text),
    // มีอยู่ในฝั่ง Codex ด้วยไหม (ถ้ามี = ชี้ path ฝั่งมันให้อ่านได้เลย)
    inCodex: fs.existsSync(path.join(CODEX_SKILL_ROOT, id, "SKILL.md")),
  };
}

function listSkills(force) {
  refreshTh();
  if (!force && Date.now() - skillCache.at < 15000) return skillCache.list;
  const list = [];
  const seen = new Set();

  for (const root of SKILL_ROOTS) {
    if (root.kind === "single") {
      const s = readSkillAt(root.dir, path.basename(root.dir), root.source);
      if (s && !seen.has(s.id)) { seen.add(s.id); list.push(s); }
      continue;
    }
    let dirs = [];
    try { dirs = fs.readdirSync(root.dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      if (seen.has(d.name)) continue;       // ชื่อซ้ำข้ามแหล่ง = เอาตัวแรกที่เจอ
      const s = readSkillAt(path.join(root.dir, d.name), d.name, root.source);
      if (!s) continue;
      seen.add(s.id);
      list.push(s);
    }
  }

  // ติดชื่อ/คำอธิบายไทยเข้าไป (ของจริงใน SKILL.md ไม่ถูกแตะ — นี่คือชั้นแปลตอนแสดงผล)
  const out = list.map(skillTh.decorate);
  // ตัวที่ใช้บ่อยกับงานในเครื่องนี้ขึ้นก่อน แล้วค่อยเรียงชื่อ (คนเลือกง่ายขึ้น)
  out.sort((a, b) => (b.star ? 1 : 0) - (a.star ? 1 : 0) || a.id.localeCompare(b.id));
  skillCache = { at: Date.now(), list: out };
  return out;
}

function findSkill(id) {
  return listSkills().find((s) => s.id === id) || null;
}

/* ----------------------------------------------------------------- state */

function emptyState() {
  return {
    // โหมด "งานนี้" — ทุกสายต้องอ่าน
    //   title = ชื่องานสั้นๆ · brief = บรีฟเต็ม (สิ่งที่พิมพ์ครั้งเดียวแล้วทุกตัวรู้)
    job: { title: "", brief: "", skills: [] },
    agents: { claude: [], codex: [], openclaw: [], antigravity: [] },
    // หน้าที่ของแต่ละสายในงานนี้ — ทุกตัวเห็นของทุกคน ไม่ใช่เห็นแค่ของตัวเอง
    roles: { claude: "", codex: "", openclaw: "", antigravity: "" },
    // ลำดับการทำงาน (1,2,3… · 0 = ไม่ระบุ)
    // ⚠️ เพิ่มเพราะบั๊กเชิงโครงสร้าง (2026-07-31): เดิมบรีฟบอกแค่ "ใครทำอะไร"
    //    ไม่บอก "ใครทำก่อน" → สายที่ควรรอ ลงมือก่อนคนที่มีหน้าที่คิด
    //    แล้ว user ต้องมาสั่งเองว่า "ทำไมไม่ไปถามมันก่อน"
    order: { claude: 0, codex: 0, openclaw: 0, antigravity: 0 },
    // สายที่เป็นผู้คุมงาน — ได้หน้าที่เพิ่มคือ "ไปสั่ง/ทวงสายอื่นเอง ห้ามรอ user"
    lead: "",
    updatedAt: 0,
  };
}

function readState() {
  const raw = safeRead(STATE_FILE);
  if (!raw) return emptyState();
  try {
    const s = JSON.parse(raw);
    const out = emptyState();
    if (s.job && typeof s.job === "object") {
      out.job.title = String(s.job.title || "").slice(0, 200);
      // หนีบตรงนี้ด้วย (ไม่ใช่แค่ตอนเขียน) เผื่อมีคนแก้ไฟล์ด้วยมือแล้วยัดมาเป็นเมกะไบต์
      out.job.brief = String(s.job.brief || "").slice(0, BRIEF_BUDGET);
      out.job.skills = Array.isArray(s.job.skills) ? s.job.skills.map(String) : [];
    }
    for (const a of AGENTS) {
      if (s.agents && Array.isArray(s.agents[a])) out.agents[a] = s.agents[a].map(String);
      if (s.roles && s.roles[a] != null) out.roles[a] = String(s.roles[a]).slice(0, ROLE_MAX);
      if (s.order && s.order[a] != null) {
        const n = parseInt(s.order[a], 10);
        out.order[a] = Number.isFinite(n) && n > 0 && n < 100 ? n : 0;
      }
    }
    if (s.lead && AGENTS.indexOf(String(s.lead)) >= 0) out.lead = String(s.lead);
    out.updatedAt = Number(s.updatedAt) || 0;
    return out;
  } catch (_) {
    return emptyState();
  }
}

/**
 * มีอะไรต้องส่งให้สายไหนไหม
 * ⚠️ สำคัญ: เดิมทุกอย่างผูกกับ "มีสกิลเสียบไหม" อย่างเดียว
 * ตอนนี้ "บรีฟเปล่าๆ ไม่มีสกิล" ก็ต้องถึงมือทุกตัวด้วย ไม่งั้นฟีเจอร์นี้ไร้ความหมาย
 */
function hasJobContent(state) {
  if (state.job.title.trim() || state.job.brief.trim()) return true;
  if (state.lead) return true;
  if (AGENTS.some((a) => state.order[a] > 0)) return true;
  return AGENTS.some((a) => (state.roles[a] || "").trim());
}

/** สายที่มีลำดับ เรียงจากก่อนไปหลัง */
function orderedLanes(state) {
  return AGENTS.filter((a) => state.order[a] > 0)
    .sort((a, b) => state.order[a] - state.order[b] || AGENTS.indexOf(a) - AGENTS.indexOf(b));
}

function hasAnything(state) {
  return hasJobContent(state) || AGENTS.some((a) => activeFor(state, a).length);
}

/** มีของสำหรับสายนี้จริงไหม (ใช้ตัดสินว่าจะเขียนบล็อกลงไฟล์ของมันหรือลบทิ้ง) */
function hasContentFor(state, agent) {
  return hasJobContent(state) || activeFor(state, agent).length > 0;
}

/** สกิลที่สายนี้ต้องอ่าน = ของงานรวม + ของรายตัว (ไม่ซ้ำ, เอาเฉพาะที่มีอยู่จริง) */
function activeFor(state, agent) {
  const ids = [...(state.job.skills || []), ...((state.agents || {})[agent] || [])];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const s = findSkill(id);
    if (s) out.push(s);
  }
  return out;
}

/* --------------------------------------------------------------- render */

/**
 * บรีฟงาน + ผังทีม — ส่วนนี้ทุกสายได้เหมือนกันเป๊ะ ยกเว้นบรรทัด "หน้าที่ของมึง"
 * เจตนา: ให้ทุกตัวเห็นว่าคนอื่นถืออะไรอยู่ ไม่ใช่เห็นแค่ของตัวเอง
 *        (บทเรียน Haven: agent ที่ไม่รู้ว่าใครถืออะไร จะไปแก้ไฟล์เลนคนอื่น)
 */
function renderBrief(state, agent) {
  if (!hasJobContent(state)) return "";

  const lines = [];
  lines.push("# 🧭 งานตอนนี้ (AI Flow — บรีฟรวมของทีม)");
  lines.push("");
  // บอกตัวตนก่อนอย่างอื่นเสมอ — ต้องอ่านเจอก่อนถึงผังทีม
  // (ถ้าไม่บอก สายที่ backend เป็น Claude จะไปสวมรอยสาย "Claude Code")
  lines.push(
    `**มึงคือสาย \`${agent}\` = ${AGENT_LABEL[agent] || agent}** — ` +
      `สายในผังข้างล่างแยกด้วย**ช่องทางที่ user คุยด้วย** ไม่ใช่ชื่อโมเดลข้างใน. ` +
      `ถ้าโมเดลข้างในมึงเป็น Claude/GPT ก็ไม่ได้ทำให้มึงเป็นสายนั้น — ` +
      `ยึด \`${agent}\` เท่านั้น`
  );
  lines.push("");
  if (state.job.title.trim()) lines.push(`**งาน:** ${state.job.title.trim()}`);
  if (state.job.brief.trim()) {
    lines.push("");
    lines.push(state.job.brief.trim());
  }

  const assigned = AGENTS.filter((a) => (state.roles[a] || "").trim());
  if (assigned.length) {
    lines.push("");
    lines.push("## ผังทีม — ใครถืออะไรอยู่");
    for (const a of AGENTS) {
      const role = (state.roles[a] || "").trim();
      const me = a === agent ? "  ← **นี่คือมึง**" : "";
      lines.push(
        `- \`${a}\` **${AGENT_SHORT[a] || a}** — ${role || "_(ไม่ได้มอบหมายรอบนี้)_"}${me}`
      );
    }
    lines.push("");
    lines.push(
      "**กฎของทีม:** ทำเฉพาะหน้าที่ของมึง **ห้ามไปแตะงานของสายอื่นแม้เห็นว่ามันผิด** — " +
        "ให้รายงานออกมาตรงๆ แล้วปล่อยให้เจ้าของงานนั้นแก้ (ถ้าแตะข้ามกัน งานจะทับกันแล้วตามรอยไม่ได้)"
    );
  }

  // ---- ลำดับงาน: บอกทั้งผังลำดับ และ "ห้ามเริ่มก่อนคิว" ของตัวเอง ----
  const lanes = orderedLanes(state);
  if (lanes.length) {
    lines.push("");
    lines.push("## ลำดับงาน — ใครทำก่อนหลัง");
    lanes.forEach(function (a) {
      const me = a === agent ? "  ← **นี่คือคิวของมึง**" : "";
      lines.push(`${state.order[a]}. \`${a}\` **${AGENT_SHORT[a] || a}** — ` +
        `${(state.roles[a] || "").trim() || "_(ไม่ได้มอบหมาย)_"}${me}`);
    });
    const mySlot = state.order[agent] || 0;
    if (mySlot > 0) {
      const before = lanes.filter((a) => state.order[a] < mySlot);
      if (before.length) {
        lines.push("");
        lines.push(
          `⛔ **มึงคือลำดับที่ ${mySlot} — ห้ามเริ่มลงมือก่อนที่ ` +
            before.map((a) => "`" + a + "`").join(" · ") +
            ` จะส่งของ** ถ้ายังไม่ส่ง **ให้ไปทวง/ไปสั่งมันเองก่อน** ` +
            `(ห้ามรอให้ user มาสั่ง และห้ามลงมือแทนมัน) ` +
            `ถ้าจำเป็นต้องเริ่มบางส่วนจริงๆ ให้บอกออกมาก่อนว่าเริ่มส่วนไหนและทำไม`
        );
      } else {
        lines.push("");
        lines.push(`▶️ **มึงคือลำดับที่ ${mySlot} = คิวแรก** เริ่มได้เลยไม่ต้องรอใคร`);
      }
    } else {
      lines.push("");
      lines.push("_(สายมึงไม่ได้ระบุลำดับ — ถ้าจะเริ่ม ให้เช็คก่อนว่าไม่ทับคิวคนอื่น)_");
    }
  }

  // ---- ผู้คุมงาน ----
  if (state.lead) {
    lines.push("");
    if (state.lead === agent) {
      lines.push(
        `## 🎛️ มึงคือ **ผู้คุมงาน** ของรอบนี้\n` +
          `หน้าที่นี้รวมถึง: **ไปสั่งและไปทวงสายอื่นด้วยตัวเอง ห้ามรอให้ user มาสั่ง** · ` +
          `เช็คว่าของที่แต่ละสายส่งมาตรงสัญญาไหม · ถ้าใครยังไม่ส่ง ให้ติดต่อไปเลย · ` +
          `ถ้าติดต่อไม่ได้จริงๆ ให้บอก user ว่าติดต่อสายไหนไม่ได้และเพราะอะไร`
      );
    } else {
      lines.push(`**ผู้คุมงานรอบนี้คือสาย \`${state.lead}\`** — ส่งของเสร็จแล้วรายงานไปที่สายนั้น`);
    }
  }

  const mine = (state.roles[agent] || "").trim();
  lines.push("");
  lines.push(`## 👉 หน้าที่ของมึงรอบนี้ — สาย \`${agent}\` (${AGENT_SHORT[agent] || agent})`);
  if (mine) {
    lines.push(mine);
  } else {
    // ⚠️ ต้องเขียนให้ชัดว่า "ไม่ได้มอบหมาย" — ห้ามเว้นว่าง
    // บั๊กจริงที่เจอตอนเทส (2026-07-31): เดิมถ้าสายไหนไม่มีหน้าที่ ส่วนนี้จะไม่ถูกเขียนเลย
    // → OpenClaw ไปหยิบ "บรรทัดแรกในผังทีม" (ของ Claude) มาตอบว่าเป็นหน้าที่ตัวเอง
    // = สายที่ว่างงานจะแอบไปทำงานของคนอื่น ซึ่งขัดกฎกันงานทับกันโดยตรง
    lines.push(
      `**รอบนี้มึงไม่ได้ถูกมอบหมายงาน** — ห้ามหยิบหน้าที่ของสายอื่นในผังข้างบนมาทำเอง ` +
        `และห้ามเริ่มลงมือกับงานนี้ ถ้ามีคนถามว่าหน้าที่มึงคืออะไร ให้ตอบตรงๆ ว่า ` +
        `"สาย ${AGENT_SHORT[agent] || agent} ไม่ได้รับมอบหมายในงานนี้"`
    );
  }

  lines.push("");
  return lines.join("\n");
}

function header(state, agent, mode) {
  const lines = [];
  lines.push("# 🔌 สกิลที่ถูกเสียบไว้ (AI Flow — Skill Patch Bay)");
  lines.push("");
  lines.push(
    `**นี่ไม่ใช่คำแนะนำ — เป็นข้อบังคับ:** ก่อนเริ่มลงมือทำอะไรก็ตามในงานนี้ ` +
      `ต้องอ่านสกิลข้างล่างให้จบก่อน แล้วทำตามมัน ถ้าสิ่งที่มึงกำลังจะทำขัดกับสกิล ให้ยึดสกิล`
  );
  lines.push(`_(สาย: ${agent} · โหมด: ${mode})_`);
  lines.push("");
  return lines.join("\n");
}

/** เนื้อเต็ม — ใช้กับช่องที่ยัดเข้า context ตรงๆ (claude hook / antigravity file) */
function renderFull(state, agent, mode) {
  const skills = activeFor(state, agent);
  const brief = renderBrief(state, agent);
  if (!skills.length) return brief;          // บรีฟเปล่าๆ ไม่มีสกิล = ส่งบรีฟไปอย่างเดียว
  const parts = [];
  if (brief) parts.push(brief);
  parts.push(header(state, agent, mode));
  let used = 0;
  for (const s of skills) {
    const body = safeRead(s.file) || "";
    const remaining = INJECT_BUDGET - used;
    let chunk = body;
    let note = "";
    if (body.length > remaining) {
      chunk = body.slice(0, Math.max(0, remaining));
      note =
        `\n\n> [ตัดที่ ${chunk.length.toLocaleString()} ตัวอักษร เพราะเกินเพดาน context] ` +
        `**ต้องอ่านไฟล์เต็มก่อนทำงาน:** \`${s.file}\``;
    }
    used += chunk.length;
    parts.push(`\n---\n\n## SKILL: ${s.name}  \`(${s.id})\`\n\n${chunk}${note}\n`);
    if (used >= INJECT_BUDGET) {
      const left = skills.slice(skills.indexOf(s) + 1);
      if (left.length) {
        parts.push(
          `\n---\n\n> เต็มเพดานแล้ว สกิลที่เหลือ **ต้องเปิดอ่านเองก่อนเริ่ม**: ` +
            left.map((x) => `\`${x.file}\``).join(" · ")
        );
      }
      break;
    }
  }
  return parts.join("\n");
}

/** แบบชี้ทาง — ใช้กับไฟล์ที่โดนอ่านทุก session (AGENTS.md / MEMORY.md) ไม่ยัดเต็มเพราะไฟล์จะบวม */
function renderPointer(state, agent, mode) {
  const skills = activeFor(state, agent);
  const brief = renderBrief(state, agent);
  if (!skills.length) return brief;
  const lines = [];
  if (brief) lines.push(brief);
  lines.push(header(state, agent, mode));
  for (const s of skills) {
    const local =
      agent === "codex" && s.inCodex
        ? path.join(CODEX_SKILL_ROOT, s.id, "SKILL.md")
        : s.file;
    lines.push(`### ${s.nameTh ? s.nameTh + " " : ""}\`(${s.id})\``);
    lines.push(`**เปิดอ่านไฟล์นี้ให้จบก่อนแตะโค้ด:** \`${local}\``);
    const d = s.descTh || s.desc;
    if (d) lines.push(`> ${d.slice(0, 400)}`);
    lines.push("");
  }
  lines.push(
    "ถ้าอ่านไม่ได้ด้วยเหตุผลใดก็ตาม ให้บอกออกมาตรงๆ ก่อนเริ่มงาน ห้ามทำต่อเงียบๆ"
  );
  return lines.join("\n");
}

/* --------------------------------------------------------------- writers */

/** แทนที่บล็อกระหว่าง marker (สร้างใหม่ต่อท้ายถ้ายังไม่มี) — ไม่แตะเนื้อหาอื่นในไฟล์ */
function upsertBlock(file, block) {
  const existing = safeRead(file);
  if (existing == null) return { ok: false, reason: "ไม่มีไฟล์: " + file };
  const wrapped = block ? `${MARK_START}\n${block}\n${MARK_END}` : "";
  const s = existing.indexOf(MARK_START);
  const e = existing.indexOf(MARK_END);
  let next;
  if (s >= 0 && e > s) {
    const before = existing.slice(0, s);
    const after = existing.slice(e + MARK_END.length);
    next = block ? before + wrapped + after : (before.replace(/\n{3,}$/, "\n\n") + after.replace(/^\n+/, ""));
  } else {
    if (!block) return { ok: true, skipped: true };
    next = existing.replace(/\s*$/, "") + "\n\n" + wrapped + "\n";
  }
  if (next === existing) return { ok: true, unchanged: true };
  atomicWrite(file, next);
  return { ok: true };
}

/** ติดตั้ง hook ให้ Claude Code (ครั้งเดียว) — hook ตัวนี้อ่าน state สดทุกครั้งที่ยิง */
function ensureClaudeHook() {
  const raw = safeRead(CLAUDE_SETTINGS);
  if (raw == null) return { ok: false, reason: "ไม่มี ~/.claude/settings.json" };
  let cfg;
  try { cfg = JSON.parse(raw); } catch (e) { return { ok: false, reason: "settings.json พัง: " + e.message }; }

  cfg.hooks = cfg.hooks || {};
  const list = Array.isArray(cfg.hooks.UserPromptSubmit) ? cfg.hooks.UserPromptSubmit : [];

  const isOurs = (h) =>
    h && Array.isArray(h.hooks) &&
    h.hooks.some((x) => Array.isArray(x.args) && x.args.some((a) => String(a).includes("skill-hook.js")));

  if (list.some(isOurs)) return { ok: true, alreadyInstalled: true };

  list.push({
    hooks: [
      {
        type: "command",
        command: process.execPath,          // node ตัวที่รัน server อยู่ (ไม่ต้องพึ่ง PATH)
        args: [HOOK_SCRIPT],                // exec form = ไม่ผ่าน shell -> path มีช่องว่างก็ไม่พัง
        timeout: 10,
        statusMessage: "เสียบสกิล…",
      },
    ],
  });
  cfg.hooks.UserPromptSubmit = list;
  atomicWrite(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + "\n");
  return { ok: true, installed: true };
}

function removeClaudeHook() {
  const raw = safeRead(CLAUDE_SETTINGS);
  if (raw == null) return { ok: false };
  let cfg;
  try { cfg = JSON.parse(raw); } catch (_) { return { ok: false }; }
  if (!cfg.hooks || !Array.isArray(cfg.hooks.UserPromptSubmit)) return { ok: true };
  const kept = cfg.hooks.UserPromptSubmit.filter(
    (h) => !(h && Array.isArray(h.hooks) &&
      h.hooks.some((x) => Array.isArray(x.args) && x.args.some((a) => String(a).includes("skill-hook.js"))))
  );
  if (kept.length) cfg.hooks.UserPromptSubmit = kept;
  else delete cfg.hooks.UserPromptSubmit;
  atomicWrite(CLAUDE_SETTINGS, JSON.stringify(cfg, null, 2) + "\n");
  return { ok: true };
}

/* ----------------------------------------------------------------- apply */

function applyAll(state) {
  const mode = hasJobContent(state) ? "งานรวม + รายตัว" : "รายตัว";
  const report = {};

  // 1) Claude — hook อ่าน state เอง แค่ต้องแน่ใจว่า hook ติดตั้งแล้ว
  //    ⚠️ ต้องดู hasAnything ไม่ใช่ "มีสกิลไหม" — บรีฟเปล่าๆ ก็ต้องติด hook
  report.claude = hasAnything(state) ? ensureClaudeHook() : { ok: true, idle: true };
  report.claude.chars = renderFull(state, "claude", mode).length;

  // 2) Codex — AGENTS.md
  report.codex = upsertBlock(AGENTS_MD, renderPointer(state, "codex", mode));
  report.codex.target = AGENTS_MD;

  // 3) OpenClaw — MEMORY.md
  if (fs.existsSync(OPENCLAW_MEMORY)) {
    report.openclaw = upsertBlock(OPENCLAW_MEMORY, renderPointer(state, "openclaw", mode));
    report.openclaw.target = OPENCLAW_MEMORY;
  } else {
    report.openclaw = { ok: false, reason: "ไม่มี " + OPENCLAW_MEMORY };
  }

  // 4) Antigravity — ไฟล์เดี่ยว เนื้อเต็ม + บรีฟให้ก๊อป
  const antiBody = renderFull(state, "antigravity", mode);
  try {
    if (antiBody) {
      atomicWrite(ANTI_ACTIVE, antiBody);
      report.antigravity = { ok: true, target: ANTI_ACTIVE, chars: antiBody.length };
    } else {
      if (fs.existsSync(ANTI_ACTIVE)) fs.unlinkSync(ANTI_ACTIVE);
      report.antigravity = { ok: true, idle: true, target: ANTI_ACTIVE };
    }
  } catch (e) {
    report.antigravity = { ok: false, reason: e.message };
  }
  report.antigravity.brief = antiBody ? antiPasteLine() : "";

  return report;
}

/**
 * บรรทัดเดียวที่ต้องวางใส่ Antigravity — ตัวเดียวที่ยังไม่มี hook
 * (ยังเสีย 1 คลิกจริง ไม่กลบ แต่ทำให้เหลือคลิกเดียวและก๊อปได้จากลิงก์เดียว)
 */
function antiPasteLine() {
  return (
    `ก่อนเริ่มงาน เปิดอ่านไฟล์นี้ให้จบก่อน แล้วทำตามมันเคร่งครัด: ${ANTI_ACTIVE} ` +
    `— ในนั้นมีบรีฟงานตอนนี้ หน้าที่ของมึง ผังทีมว่าใครถืออะไร และสกิลที่ถูกบังคับให้อ่าน`
  );
}

/**
 * เขียน state — แต่ปฏิเสธถ้าคนส่งถือข้อมูลเก่ากว่าที่อยู่ในไฟล์
 *
 * ⚠️ บั๊กจริงที่เคยเกิด (2026-07-31): แท็บเบราว์เซอร์ที่เปิดค้างถือ snapshot เก่าไว้
 *    พอมีอะไรทริกเกอร์ save มันยิง state เก่าทั้งก้อนทับ → **งานที่ถูกลบไปแล้วฟื้นกลับมา**
 *    (ซ้ำรอยบทเรียน cloud sync ของ SakuraQ: last-write-wins ไม่ปลอดภัยเมื่อมีหลายผู้เขียน)
 *    ถ้า client ส่ง baseUpdatedAt มา แล้วไฟล์ใหม่กว่า = ตีกลับให้ไปโหลดใหม่ ห้ามเขียนทับเงียบๆ
 */
function writeState(next) {
  if (next && next.baseUpdatedAt != null) {
    const cur = readState();
    if (cur.updatedAt > Number(next.baseUpdatedAt)) {
      return {
        conflict: true,
        state: cur,
        report: {},
        verify: verify(cur),
        reason: "มีคนอื่น (หรือแท็บอื่น) แก้ทีหลัง — โหลดของใหม่ก่อนแล้วแก้ซ้ำ",
      };
    }
  }
  const state = emptyState();
  if (next && next.job) {
    state.job.title = String(next.job.title || "").slice(0, 200);
    state.job.brief = String(next.job.brief || "").slice(0, BRIEF_BUDGET);
    state.job.skills = (Array.isArray(next.job.skills) ? next.job.skills : [])
      .map(String).filter((id) => !!findSkill(id));
  }
  for (const a of AGENTS) {
    const arr = next && next.agents && Array.isArray(next.agents[a]) ? next.agents[a] : [];
    state.agents[a] = arr.map(String).filter((id) => !!findSkill(id));
    const role = next && next.roles ? next.roles[a] : "";
    state.roles[a] = String(role == null ? "" : role).slice(0, ROLE_MAX);
    const ord = next && next.order ? parseInt(next.order[a], 10) : 0;
    state.order[a] = Number.isFinite(ord) && ord > 0 && ord < 100 ? ord : 0;
  }
  if (next && next.lead && AGENTS.indexOf(String(next.lead)) >= 0) state.lead = String(next.lead);
  state.updatedAt = Date.now();
  atomicWrite(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
  const report = applyAll(state);
  return { state, report, verify: verify(state) };
}

/* ---------------------------------------------------------------- verify */

/** อ่านกลับจากปลายทางจริง — ไฟเขียวต้องมาจากไฟล์ ไม่ใช่จากความหวังดี */
function verify(state) {
  const out = {};

  // claude: hook ติดตั้งจริงไหม + hook รันแล้วคายอะไรออกมาไหม
  const raw = safeRead(CLAUDE_SETTINGS);
  let hookOn = false;
  try {
    const cfg = JSON.parse(raw || "{}");
    hookOn = (cfg.hooks && Array.isArray(cfg.hooks.UserPromptSubmit) ? cfg.hooks.UserPromptSubmit : [])
      .some((h) => h && Array.isArray(h.hooks) &&
        h.hooks.some((x) => Array.isArray(x.args) && x.args.some((a) => String(a).includes("skill-hook.js"))));
  } catch (_) {}
  const claudeChars = renderFull(state, "claude", "verify").length;
  out.claude = {
    ok: !hasContentFor(state, "claude") || hookOn,
    hookInstalled: hookOn,
    chars: claudeChars,
    note: hookOn ? "hook ติดตั้งแล้ว (มีผลกับ session ใหม่)" : "ยังไม่ได้ติดตั้ง hook",
  };

  // codex / openclaw: บล็อกอยู่ในไฟล์จริงไหม
  for (const [agent, file] of [["codex", AGENTS_MD], ["openclaw", OPENCLAW_MEMORY]]) {
    const text = safeRead(file);
    const want = hasContentFor(state, agent);
    const has = !!text && text.includes(MARK_START) && text.includes(MARK_END);
    const names = activeFor(state, agent).map((s) => s.id);
    const allIn = !!text && names.every((id) => text.includes(id));
    out[agent] = {
      ok: text != null && (want ? has && allIn : !has || true),
      target: file,
      blockPresent: has,
      missing: text == null ? "ไม่มีไฟล์" : null,
    };
  }

  // antigravity: ไฟล์มีจริง + เนื้อครบไหม
  const anti = safeRead(ANTI_ACTIVE);
  const wantAnti = hasContentFor(state, "antigravity");
  out.antigravity = {
    ok: wantAnti ? anti != null && anti.trim().length > 0 : true,
    target: ANTI_ACTIVE,
    chars: anti ? anti.length : 0,
    needsPaste: wantAnti, // ตัวนี้ยังต้องอาศัยคนวางบรีฟ 1 ครั้ง — พูดตรงๆ
  };

  return out;
}

module.exports = {
  listSkills,
  readState,
  writeState,
  applyAll,
  verify,
  activeFor,
  renderFull,
  renderBrief,
  hasJobContent,
  hasAnything,
  hasContentFor,
  orderedLanes,
  antiPasteLine,
  AGENTS,
  AGENT_LABEL,
  STATE_FILE,
  ANTI_ACTIVE,
  removeClaudeHook,
  INJECT_BUDGET,
  BRIEF_BUDGET,
  ROLE_MAX,
};

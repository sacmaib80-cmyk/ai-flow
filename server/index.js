"use strict";
/**
 * AI Flow — server
 *
 * หน้าที่: อ่านสัญญาณจากทุกสาย (sources.js) แล้วดันขึ้นหน้าเว็บแบบสด
 *  - HTTP  : เสิร์ฟไฟล์ใน web/ + assets/
 *  - WS    : push snapshot ทุกครั้งที่มีอะไรเปลี่ยน
 *
 * กันพัง:
 *  - poll แบบ adaptive (เร็วตอนมีความเคลื่อนไหว ช้าลงตอนเงียบ) ไม่เผา CPU
 *  - ส่งเฉพาะตอน "เปลี่ยนจริง" (เทียบ fingerprint) ไม่ spam ทุก tick
 *  - source ไหนพังต้องไม่ล้มทั้ง server (ครอบ try ทุกชั้น)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { collectAll } = require("./sources.js");
const skills = require("./skills.js");

const PORT = Number(process.env.PORT || 7788);
const ROOT = path.join(__dirname, "..");
const WEB = path.join(ROOT, "web");
const ASSETS = path.join(ROOT, "assets");
const TMP = path.join(os.tmpdir(), "ai-flow");
try { fs.mkdirSync(TMP, { recursive: true }); } catch (_) {}

// ws มาจาก node_modules ของ d:\git (มีอยู่แล้ว ไม่ต้องลงเพิ่ม)
let WebSocketServer = null;
try { ({ WebSocketServer } = require("ws")); }
catch (_) {
  try { ({ WebSocketServer } = require(path.join("D:", "git", "node_modules", "ws"))); }
  catch (_) { console.error("[ai-flow] หา ws ไม่เจอ — จะรันแบบ polling อย่างเดียว"); }
}

/* ------------------------------------------------------------- static */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function serve(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      // ⚠️ 404 ต้อง no-store ด้วย ไม่งั้นเบราว์เซอร์จำ "ไม่มีไฟล์นี้" ค้างไว้
      // (เคยเจอจริง: เปิดหน้าเว็บตอนไฟล์ css ยังไม่ถูกสร้าง → Firefox จำ 404
      //  แล้วไม่ขอใหม่อีกเลย แผงเลยเปิดมาแบบไม่มีสไตล์จนมองไม่เห็น)
      res.writeHead(404, { "content-type": "text/plain", "cache-control": "no-store" });
      return res.end("not found");
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
      "cache-control": "no-store", // ไฟล์ theme.css ถูกแก้บ่อย (Antigravity) ห้าม cache
    });
    res.end(buf);
  });
}

function sendJson(res, obj, code) {
  res.writeHead(code || 200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(obj));
}

/** อ่าน body ของ POST (จำกัดขนาด กัน request บ้าๆ) */
function readBody(req, cb) {
  // ⚠️ ต้องเก็บเป็น Buffer แล้วค่อย toString('utf8') ตอนจบ
  // ถ้า `buf += chunk` ตรงๆ ตัวอักษรไทยที่ถูกหั่นคาบเกี่ยว 2 chunk จะเพี้ยนเป็นขยะ
  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > 200000) { tooBig = true; req.destroy(); return; }
    chunks.push(c);
  });
  req.on("end", () => cb(tooBig ? null : Buffer.concat(chunks).toString("utf8")));
  req.on("error", () => cb(null));
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** หน้า /anti — ปุ่มเดียวจบสำหรับสายที่บังคับด้วยระบบไม่ได้ */
function sendAntiPage(res) {
  const state = skills.readState();
  const mode = skills.hasJobContent(state) ? "งานรวม + รายตัว" : "รายตัว";
  const body = skills.renderFull(state, "antigravity", mode);
  const has = !!(body && body.trim());
  const line = has ? skills.antiPasteLine() : "";
  const v = skills.verify(state);
  const fileChars = (v.antigravity && v.antigravity.chars) || 0;

  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>บรีฟสำหรับ Antigravity — AI Flow</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;padding:28px 20px 60px;background:#0B0E11;color:#E6EBF0;
       font:15px/1.6 "Segoe UI",system-ui,sans-serif}
  .wrap{max-width:820px;margin:0 auto}
  h1{font-size:19px;margin:0 0 4px;letter-spacing:.2px}
  h1 b{color:#C77DD9}
  .sub{color:#8A97A6;font-size:13px;margin:0 0 24px}
  .card{background:#11161B;border:1px solid #212A32;border-radius:12px;padding:18px;margin-bottom:16px}
  .card.hot{border-color:#C77DD9;box-shadow:0 0 0 1px rgba(199,125,217,.25),0 10px 40px -20px rgba(199,125,217,.6)}
  .k{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:#8A97A6;margin:0 0 10px}
  pre{margin:0;padding:14px;background:#0B0E11;border:1px solid #212A32;border-radius:8px;
      white-space:pre-wrap;word-break:break-word;font:13px/1.65 ui-monospace,Consolas,monospace;color:#D7E1EA}
  button{margin-top:14px;width:100%;padding:14px 18px;border:0;border-radius:10px;cursor:pointer;
         background:#C77DD9;color:#14060F;font:600 15px/1 "Segoe UI",system-ui,sans-serif}
  button:active{transform:translateY(1px)}
  button[data-done="1"]{background:#43D9A3}
  .row{display:flex;gap:10px;flex-wrap:wrap;font-size:12.5px;color:#8A97A6;margin-top:12px}
  .row span{background:#0B0E11;border:1px solid #212A32;border-radius:999px;padding:5px 11px}
  details{margin-top:6px}
  summary{cursor:pointer;color:#8A97A6;font-size:13px;padding:4px 0}
  a{color:#4FB8E8}
  .empty{color:#8A97A6}
</style>
<div class="wrap">
  <h1>บรีฟสำหรับ <b>Antigravity</b></h1>
  <p class="sub">ตัวนี้ยังไม่มี hook ให้เสียบ (grep หาแล้วไม่เจอใน app.asar) จึงต้องวางบรีฟด้วยมือ 1 ครั้ง —
     หน้านี้ทำให้เหลือ กดปุ่ม → วางในแชท Antigravity</p>

  ${has ? `
  <div class="card hot">
    <p class="k">วางบรรทัดนี้ในแชท Antigravity</p>
    <pre id="line">${esc(line)}</pre>
    <button id="copy" type="button">คัดลอกบรรทัดนี้</button>
    <div class="row">
      <span>ไฟล์ปลายทางเขียนแล้ว ${fileChars.toLocaleString()} ตัวอักษร</span>
      <span>${esc(state.job.title || "ยังไม่ได้ตั้งชื่องาน")}</span>
    </div>
  </div>

  <div class="card">
    <p class="k">สิ่งที่ Antigravity จะได้อ่าน (ตรวจก่อนวางได้)</p>
    <details open><summary>ย่อ / ขยาย</summary><pre>${esc(body)}</pre></details>
  </div>` : `
  <div class="card">
    <p class="k">ยังไม่มีอะไรต้องส่ง</p>
    <p class="empty">ยังไม่ได้ตั้งงาน ไม่ได้มอบหมายหน้าที่ และไม่ได้เสียบสกิลให้ Antigravity —
       ไปตั้งที่ <a href="/">แผงปลั๊กสกิล</a> ก่อน แล้วรีเฟรชหน้านี้</p>
  </div>`}

  <p class="sub" style="margin:0">
    <a href="/anti">รีเฟรช</a> · <a href="/">กลับไป AI Flow</a> ·
    ไฟล์จริง: <code>${esc(skills.ANTI_ACTIVE)}</code>
  </p>
</div>
<script>
(function(){
  var b=document.getElementById("copy"), p=document.getElementById("line");
  if(!b||!p) return;
  b.addEventListener("click",function(){
    var t=p.textContent;
    function done(){ b.textContent="คัดลอกแล้ว — ไปวางในแชท Antigravity"; b.setAttribute("data-done","1"); }
    if(navigator.clipboard&&navigator.clipboard.writeText){
      navigator.clipboard.writeText(t).then(done,fallback);
    } else fallback();
    function fallback(){
      // clipboard API ใช้ไม่ได้บน http บางเคส -> ท่าเก่าที่ยังทำงาน
      var ta=document.createElement("textarea");
      ta.value=t; ta.style.position="fixed"; ta.style.opacity="0";
      document.body.appendChild(ta); ta.select();
      try{ document.execCommand("copy"); done(); }
      catch(e){ b.textContent="ก๊อปอัตโนมัติไม่ได้ — เลือกข้อความข้างบนแล้ว Ctrl+C"; }
      document.body.removeChild(ta);
    }
  });
})();
</script>`;

  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(html);
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);

  /* --------------------------------------------------- ปลั๊กสกิล */

  if (url === "/api/skills") {
    if (req.method === "GET") {
      const state = skills.readState();
      return sendJson(res, {
        skills: skills.listSkills(true),
        state,
        verify: skills.verify(state),
        budget: skills.INJECT_BUDGET,
        briefBudget: skills.BRIEF_BUDGET,
        roleMax: skills.ROLE_MAX,
        antiPath: skills.ANTI_ACTIVE,
        antiBrief: skills.hasContentFor(state, "antigravity") ? skills.antiPasteLine() : "",
      });
    }
    if (req.method === "POST") {
      return readBody(req, (body) => {
        if (body == null) return sendJson(res, { ok: false, error: "body ใหญ่เกินไป" }, 413);
        let next;
        try { next = JSON.parse(body); }
        catch (e) { return sendJson(res, { ok: false, error: "JSON พัง: " + e.message }, 400); }
        try {
          const r = skills.writeState(next);
          if (r.conflict) {
            console.log("[ai-flow] ตีกลับการเขียนทับจากแท็บเก่า — " + r.reason);
            return sendJson(res, { ok: false, conflict: true, error: r.reason, state: r.state, verify: r.verify }, 409);
          }
          console.log(`[ai-flow] ปลั๊กสกิลอัปเดต — งาน:"${r.state.job.title || "-"}" ` +
            `บรีฟ:${r.state.job.brief.length}ตัวอักษร ` +
            Object.keys(r.state.agents).map((a) =>
              `${a}:${r.state.agents[a].length}${r.state.roles[a] ? "+หน้าที่" : ""}`).join(" "));
          return sendJson(res, {
            ok: true, ...r,
            skills: skills.listSkills(true),
            antiBrief: skills.hasContentFor(r.state, "antigravity") ? skills.antiPasteLine() : "",
          });
        } catch (e) {
          console.error("[ai-flow] เสียบสกิลไม่สำเร็จ:", e.message);
          return sendJson(res, { ok: false, error: e.message }, 500);
        }
      });
    }
    return sendJson(res, { ok: false, error: "method ไม่รองรับ" }, 405);
  }

  // เบราว์เซอร์ขอเองทุกครั้ง ถ้าไม่ตอบจะมี 404 รกใน console เปล่าๆ
  if (url === "/favicon.ico") {
    res.writeHead(204);
    return res.end();
  }

  /* ------------------------------------- ลิงก์พิเศษของ Antigravity
     ตัวเดียวที่ไม่มี hook ให้เสียบ → มันต้องอาศัยคนวางบรีฟ 1 ครั้ง
     หน้านี้ทำให้ "1 ครั้ง" นั้นเหลือ: เปิดลิงก์ → กดปุ่ม → วาง
     เสิร์ฟ HTML ที่ประกอบเสร็จจาก server เลย (ไม่ต้องพึ่ง JS ฝั่งหน้าเว็บนอกจากปุ่มก๊อป) */
  if (url === "/anti" || url === "/antigravity") {
    return sendAntiPage(res);
  }

  if (url === "/api/snapshot") {
    return collectAll(TMP, (data) => {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    });
  }

  let file;
  if (url === "/" || url === "/index.html") file = path.join(WEB, "index.html");
  else if (url.startsWith("/assets/")) file = path.join(ASSETS, url.slice(8));
  else file = path.join(WEB, url.replace(/^\//, ""));

  // กันหลุดออกนอกโฟลเดอร์โปรเจกต์
  const resolved = path.resolve(file);
  if (!resolved.startsWith(path.resolve(WEB)) && !resolved.startsWith(path.resolve(ASSETS))) {
    res.writeHead(403); return res.end("forbidden");
  }
  serve(res, resolved);
});

/* ------------------------------------------------------------- live push */

const clients = new Set();
let wss = null;
if (WebSocketServer) {
  wss = new WebSocketServer({ server });
  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
    if (lastSnapshot) {
      try { ws.send(JSON.stringify({ type: "snapshot", data: lastSnapshot })); } catch (_) {}
    }
  });
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    try { if (ws.readyState === 1) ws.send(msg); } catch (_) { clients.delete(ws); }
  }
}

/* ------------------------------------------------------------- poll loop */

let lastSnapshot = null;
let lastPrint = "";
let busyUntil = 0;

/** ลายนิ้วมือของ snapshot — ใช้ตัดสินว่า "เปลี่ยนจริงไหม" ก่อนยิงหาหน้าเว็บ */
function fingerprint(d) {
  // กัน source ตัวเดียวที่ลืมใส่ feed ทำให้ลูปอัปเดตสดตายทั้งระบบ (เคยเกิดจริงกับช่อง news)
  return d.channels.map((c) => `${c.ch}:${c.state}:${c.lastTs}:${((c.feed && c.feed[0]) || {}).text || ""}`).join("|");
}

let lastFp = "";
function tick() {
  let interval = 4000;
  try {
    collectAll(TMP, (data) => {
      try {
        const fp = fingerprint(data);
        const changed = fp !== lastFp;
        lastFp = fp;
        lastSnapshot = data;

        if (changed) {
          busyUntil = Date.now() + 30e3; // มีความเคลื่อนไหว → เร่ง poll 30 วิ
          broadcast({ type: "snapshot", data });
          const live = data.channels.filter((c) => c.state === "live").map((c) => c.ch).join(",");
          const line = `live=[${live}]`;
          if (line !== lastPrint) { console.log(`[ai-flow] ${new Date().toLocaleTimeString()} ${line}`); lastPrint = line; }
        }
      } catch (e) {
        console.error("[ai-flow] tick error:", e.message);
      } finally {
        interval = Date.now() < busyUntil ? 1500 : 5000;
        setTimeout(tick, interval);
      }
    });
  } catch (e) {
    console.error("[ai-flow] collect error:", e.message);
    setTimeout(tick, 8000);
  }
}

/* --------------------------------------------- watch: ให้ไวขึ้นเมื่อมีไฟล์ขยับ */

function watchDir(dir, label) {
  try {
    fs.watch(dir, { persistent: false }, () => {
      busyUntil = Date.now() + 20e3; // มีไฟล์ขยับ → เร่ง poll ทันที
    });
  } catch (_) { /* โฟลเดอร์อาจไม่มี ไม่เป็นไร */ }
}

const HOME = os.homedir();
watchDir(path.join(HOME, ".claude", "projects", "d--git"), "claude");
watchDir(path.join(HOME, ".openclaw", "state"), "openclaw");
watchDir(path.join(ROOT, "web"), "web"); // Antigravity แก้ theme.css → เร่ง reload

server.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  AI Flow — แผนที่เส้นสายระบบอัตโนมัติ`);
  console.log(`  เปิดที่:  http://127.0.0.1:${PORT}\n`);
  console.log(`  (Ctrl+C เพื่อหยุด)\n`);
  tick();
});

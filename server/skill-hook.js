#!/usr/bin/env node
"use strict";
/**
 * skill-hook.js — hook UserPromptSubmit ของ Claude Code
 *
 * นี่คือ "สวิตช์บังคับ" จริงๆ: harness เป็นคนยัดข้อความนี้เข้า context ทุก prompt
 * โมเดลไม่มีทางเลือกที่จะไม่อ่าน (ต่างจากการเขียนใน CLAUDE.md ที่เป็นการขอความร่วมมือ)
 *
 * ⚡ โหมดประหยัด (สำคัญ — เหตุผลที่เพดานไม่ต้องต่ำอีกต่อไป):
 *   ข้อความที่ hook ยัด **ไม่ได้หายไปหลังใช้** มันค้างอยู่ในประวัติบทสนทนา
 *   ยัดเต็ม 10KB ทุกข้อความ × คุย 20 ข้อความ = ข้อความเดิมซ้ำ 20 ชุดกินที่ context
 *   → ครั้งแรกของแต่ละ session (หรือทุกครั้งที่เปลี่ยนปลั๊ก) ยัด "เนื้อเต็ม"
 *     ครั้งต่อๆ ไป ยัดแค่บรรทัดเตือนสั้นๆ + path
 *   ผลคือเสียบสกิลใหญ่ๆ หลายตัวได้ โดยไม่เผา context ทิ้ง
 *
 * กฎเหล็กของไฟล์นี้: **ห้ามพัง ห้ามช้า**
 *   ไม่มีสกิลเสียบ / อะไรพังก็ตาม -> เงียบสนิท exit 0
 *   (hook พังต้องไม่ทำให้ Claude Code ใช้ไม่ได้)
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const SEEN_FILE = path.join(os.tmpdir(), "ai-flow-skill-hook-seen.json");
const SEEN_TTL_MS = 24 * 60 * 60 * 1000;   // ล้างของเก่าทิ้ง ไม่ให้ไฟล์บวม

function finish(out) {
  if (out) process.stdout.write(out);
  process.exit(0);
}

function readSeen() {
  try {
    const j = JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"));
    const now = Date.now();
    for (const k of Object.keys(j)) {
      if (!j[k] || now - (j[k].at || 0) > SEEN_TTL_MS) delete j[k];
    }
    return j;
  } catch (_) { return {}; }
}

function writeSeen(obj) {
  try { fs.writeFileSync(SEEN_FILE, JSON.stringify(obj), "utf8"); } catch (_) {}
}

function run(stdinRaw) {
  let out = "";
  try {
    const skills = require("./skills.js");
    const state = skills.readState();
    const mode = skills.hasJobContent(state) ? "งานรวม + รายตัว" : "รายตัว";
    const active = skills.activeFor(state, "claude");
    // ⚠️ ไม่ใช่แค่ "มีสกิลไหม" — บรีฟงาน/หน้าที่เปล่าๆ ก็ต้องส่ง
    if (!skills.hasContentFor(state, "claude")) return finish("");

    let sessionId = "";
    try { sessionId = String((JSON.parse(stdinRaw || "{}") || {}).session_id || ""); } catch (_) {}

    // ลายนิ้วมือของ "ชุดปลั๊ก + บรีฟตอนนี้"
    // เปลี่ยนสกิล *หรือ* เปลี่ยนบรีฟ/หน้าที่ = ต้องยัดเนื้อเต็มใหม่ทันที
    const fp = crypto
      .createHash("sha1")
      .update(
        active.map((s) => s.id + ":" + s.bytes).join("|") +
          "|" + state.job.title +
          "|" + state.job.brief +
          "|" + skills.AGENTS.map((a) =>
            a + "=" + (state.roles[a] || "") + "#" + (state.order[a] || 0)).join(";") +
          "|lead=" + (state.lead || "")
      )
      .digest("hex")
      .slice(0, 12);

    const seen = readSeen();
    const key = sessionId || "no-session";
    const alreadyFull = seen[key] && seen[key].fp === fp;

    let body;
    if (alreadyFull) {
      // รอบถัดๆ ไป: เตือนสั้นๆ พอ (เนื้อเต็มยังอยู่ในประวัติบทสนทนาข้างบนอยู่แล้ว)
      // จงใจย้ำ "งาน + หน้าที่ของมึง" ทุกรอบ เพราะ 2 อย่างนี้สั้นและเป็นตัวที่หลุดง่ายสุด
      // แต่ไม่ย้ำบรีฟเต็ม/เนื้อสกิล — พวกนั้นอยู่ในประวัติแล้ว ย้ำซ้ำ = เผา context เปล่า
      const lines = [];
      if (active.length) {
        lines.push("🔌 **สกิลที่ถูกบังคับอยู่ (ยังมีผล):** " +
          active.map((s) => "`" + s.id + "`").join(" · "));
      }
      if (state.job.title) lines.push("🧭 **งานตอนนี้:** " + state.job.title);
      const mine = (state.roles.claude || "").trim();
      if (mine) lines.push("👉 **หน้าที่ของมึงรอบนี้:** " + mine);
      if (active.length) {
        lines.push("เนื้อเต็มอยู่ข้างบนในบทสนทนานี้แล้ว — ถ้าจำไม่ได้ให้เปิดอ่านซ้ำ: " +
          active.map((s) => "`" + s.file + "`").join(" · "));
      }
      body = lines.join("\n");
    } else {
      body = skills.renderFull(state, "claude", mode);
      seen[key] = { fp, at: Date.now() };
      writeSeen(seen);
    }

    if (body && body.trim()) {
      out = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: body,
        },
        suppressOutput: true,
      });
    }
  } catch (_) {
    out = ""; // เงียบ — hook ไม่ใช่ที่สำหรับโวยวาย
  }
  finish(out);
}

// อ่าน stdin แบบไม่ค้าง: ถ้าไม่มีอะไรส่งมาใน 400ms ก็ไปต่อ
let raw = "";
let done = false;
const go = () => { if (!done) { done = true; run(raw); } };
try {
  if (process.stdin.isTTY) go();
  else {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (raw += d));
    process.stdin.on("end", go);
    process.stdin.on("error", go);
    setTimeout(go, 400);
  }
} catch (_) { go(); }

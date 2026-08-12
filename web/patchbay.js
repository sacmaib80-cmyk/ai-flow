"use strict";
/* =========================================================================
   patchbay.js — เลน Claude: แผงปลั๊กสกิล (Skill Patch Bay)

   ลากสกิลจากชั้นวางซ้าย → เสียบเข้าช่องของ AI แต่ละตัวทางขวา
   เสียบแล้ว = AI ตัวนั้น "ต้องอ่านสกิลก่อนเริ่มงาน" โดยไม่มีทางข้าม
   (ฝั่งบังคับจริงอยู่ที่ server/skills.js — ที่นี่คือหน้าปัดกับสาย)

   สัญญาให้ theme.css:
     .pb-jack[data-skill][data-plugged]
     .pb-socket[data-agent][data-verify="ok|warn|fail|idle"]
     .pb-cable[data-agent]
   ========================================================================= */

(function () {
  var API = "/api/skills";

  var el = {};
  var data = { skills: [], state: null, verify: {}, budget: 20000, antiPath: "" };
  var drag = null;      // {skillId, ghostEl}
  var busy = false;

  var AGENT_META = {
    job:         { label: "งานนี้ (ทุกสาย)", note: "เสียบตรงนี้ = บังคับทุกตัวพร้อมกัน" },
    claude:      { label: "Claude Code",     note: "ยัดเข้าทุก prompt — ข้ามไม่ได้",
                   roleHint: "แก้บั๊ก collision + เขียนเทส" },
    codex:       { label: "Codex / GPT",     note: "ผ่าน AGENTS.md",
                   roleHint: "ตรวจงานที่ตัวเองไม่ได้เขียน" },
    openclaw:    { label: "OpenClaw",        note: "ผ่าน MEMORY.md",
                   roleHint: "สรุป/แจ้งเตือนเข้า Telegram" },
    antigravity: { label: "Antigravity",     note: "เนื้อเต็มในไฟล์ + ต้องก๊อปบรีฟ 1 ครั้ง",
                   roleHint: "ทำ UI + สีประจำสาย" },
  };
  var AGENTS = ["job", "claude", "codex", "openclaw", "antigravity"];

  /* ------------------------------------------------------------ helpers */

  function kb(n) { return (n / 1024).toFixed(1) + " KB"; }
  /** ประมาณ token — ไทยกินมากกว่าอังกฤษ ใช้ ~3.4 ตัวอักษร/token แบบอนุรักษ์นิยม */
  function tok(n) { return Math.round(n / 3.4); }

  function skillById(id) {
    for (var i = 0; i < data.skills.length; i++) if (data.skills[i].id === id) return data.skills[i];
    return null;
  }

  function listFor(agent) {
    if (!data.state) return [];
    return agent === "job" ? (data.state.job.skills || []) : ((data.state.agents || {})[agent] || []);
  }

  function roleFor(agent) {
    if (!data.state || !data.state.roles || agent === "job") return "";
    return data.state.roles[agent] || "";
  }

  /**
   * มีบรีฟงานอยู่ไหม (ชื่องาน / บรีฟ / หน้าที่สักตัว)
   * ต้องเช็คตัวนี้ทุกที่ที่เคยเช็คแค่ "มีสกิลไหม" — ไม่งั้นช่องจะขึ้นว่า "ว่าง"
   * ทั้งที่สายนั้นได้รับบรีฟไปแล้วจริง = หลอกตาคนดู (บั๊กเดิมที่เคยเจอกับ chip inherit)
   */
  function hasJob() {
    if (!data.state) return false;
    if ((data.state.job.title || "").trim() || (data.state.job.brief || "").trim()) return true;
    if (data.state.lead) return true;
    for (var i = 0; i < AGENTS.length; i++) {
      var a = AGENTS[i];
      if (a === "job") continue;
      if (roleFor(a).trim()) return true;
      if (orderFor(a) > 0) return true;
    }
    return false;
  }

  function orderFor(agent) {
    if (!data.state || !data.state.order || agent === "job") return 0;
    return parseInt(data.state.order[agent], 10) || 0;
  }

  /** สายที่มีลำดับ เรียงก่อนหลัง (ใช้โชว์ผังลำดับให้คนดูเห็นตรงกับที่ AI เห็น) */
  function laneOrder() {
    var out = [];
    for (var i = 0; i < AGENTS.length; i++) {
      var a = AGENTS[i];
      if (a !== "job" && orderFor(a) > 0) out.push(a);
    }
    out.sort(function (x, y) { return orderFor(x) - orderFor(y); });
    return out;
  }

  /** ตัวอักษรที่สายนี้จะโดนยัดจริง = ของงานรวม + ของตัวเอง (ไม่นับซ้ำ) */
  function charsFor(agent) {
    var ids = agent === "job" ? listFor("job") : listFor("job").concat(listFor(agent));
    var seen = {}, total = 0;
    for (var i = 0; i < ids.length; i++) {
      if (seen[ids[i]]) continue;
      seen[ids[i]] = 1;
      var s = skillById(ids[i]);
      if (s) total += s.bytes;
    }
    return total;
  }

  function anySkillPlugged() {
    for (var i = 0; i < AGENTS.length; i++) if (listFor(AGENTS[i]).length) return true;
    return false;
  }

  function isPlugged(id) {
    for (var i = 0; i < AGENTS.length; i++) {
      if (listFor(AGENTS[i]).indexOf(id) >= 0) return true;
    }
    return false;
  }

  /* --------------------------------------------------------- networking */

  function load(cb) {
    fetch(API, { cache: "no-store" })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        data.skills = j.skills || [];
        data.state = j.state;
        data.verify = j.verify || {};
        data.budget = j.budget || 20000;
        data.briefBudget = j.briefBudget || 4000;
        data.roleMax = j.roleMax || 400;
        data.antiPath = j.antiPath || "";
        data.antiBrief = j.antiBrief || "";
        render();
        if (cb) cb();
      })
      .catch(function (e) { setStatus("ต่อ server ไม่ได้: " + e.message, "fail"); });
  }

  var saveTimer = null;
  var savePending = false;

  /** พิมพ์อยู่ยังไม่ต้องยิงทุกตัวอักษร — รอเงียบก่อนค่อยส่ง */
  function saveSoon(ms) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; save(); }, ms == null ? 900 : ms);
  }
  function saveNow() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    save();
  }

  function save() {
    if (!data.state) return;
    // ⚠️ เดิม busy = ทิ้ง request ทิ้งเลย -> ตัวอักษรที่พิมพ์ระหว่างรอ save หายจริง
    //    ต้องจำไว้ว่ายังมีของค้าง แล้วยิงซ้ำตอนรอบก่อนหน้าจบ
    if (busy) { savePending = true; return; }
    busy = true;
    setStatus("กำลังเสียบ…", "busy");
    fetch(API, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // baseUpdatedAt = เวอร์ชันที่แท็บนี้ถืออยู่ → server ตีกลับได้ถ้ามีคนแก้ทีหลัง
      body: JSON.stringify(Object.assign({}, data.state, { baseUpdatedAt: data.state.updatedAt || 0 })),
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        busy = false;
        if (j.conflict) {
          // แท็บนี้ถือของเก่า — รับของใหม่จาก server มาแทน ห้ามดันของเก่าทับ
          if (j.state) data.state = j.state;
          if (j.verify) data.verify = j.verify;
          savePending = false;
          render();
          setStatus("มีการแก้จากที่อื่นทีหลัง — โหลดของใหม่มาให้แล้ว ตรวจแล้วแก้อีกรอบ", "warn");
          return;
        }
        if (!j.ok) { setStatus("ไม่สำเร็จ: " + (j.error || "?"), "fail"); return; }
        data.state = j.state;
        data.verify = j.verify || {};
        data.antiBrief = j.antiBrief || "";
        if (j.skills) data.skills = j.skills;
        render();
        reportAfterSave(j.report || {});
        flushPending();
      })
      .catch(function (e) {
        busy = false;
        setStatus("ยิงไม่ถึง server: " + e.message, "fail");
        flushPending();
      });
  }

  function flushPending() {
    if (!savePending) return;
    savePending = false;
    save();
  }

  /** บอกผลจากไฟล์จริง ไม่ใช่ "บันทึกแล้ว" ลอยๆ */
  function reportAfterSave(rep) {
    var ok = [], bad = [];
    for (var a in rep) {
      if (!rep.hasOwnProperty(a)) continue;
      if (rep[a] && rep[a].ok === false) bad.push(a + " (" + (rep[a].reason || "?") + ")");
      else if (rep[a] && !rep[a].idle) ok.push(a);
    }
    var what = anySkillPlugged() ? "เสียบแล้ว" : "ส่งบรีฟแล้ว";
    if (bad.length) setStatus("เขียนไม่ผ่าน: " + bad.join(" · "), "fail");
    else if (ok.length) setStatus(what + " — ยืนยันจากไฟล์จริง: " + ok.join(" · "), "ok");
    else setStatus("ล้างหมดแล้ว ทุกสายกลับสู่ปกติ", "idle");
  }

  function setStatus(msg, kind) {
    if (!el.status) return;
    el.status.textContent = msg;
    el.status.setAttribute("data-kind", kind || "idle");
  }

  /* -------------------------------------------------------- mutate state */

  function plug(skillId, agent) {
    if (!data.state) return;
    var arr = agent === "job" ? data.state.job.skills : data.state.agents[agent];
    if (!arr || arr.indexOf(skillId) >= 0) return;   // เสียบซ้ำช่องเดิม = ไม่ทำอะไร
    arr.push(skillId);
    save();
  }

  function unplug(skillId, agent) {
    if (!data.state) return;
    var arr = agent === "job" ? data.state.job.skills : data.state.agents[agent];
    var i = arr ? arr.indexOf(skillId) : -1;
    if (i < 0) return;
    arr.splice(i, 1);
    save();
  }

  function unplugAll() {
    if (!data.state) return;
    data.state.job.skills = [];
    for (var a in data.state.agents) if (data.state.agents.hasOwnProperty(a)) data.state.agents[a] = [];
    save();
  }

  /* -------------------------------------------------------------- render */

  function render() {
    if (!data.state) return;
    syncJobInputs();
    renderRack();
    // renderSockets สร้าง DOM ใหม่ทั้งก้อน → ช่อง "หน้าที่" ที่กำลังพิมพ์จะถูกทำลาย
    // ต้องจำว่าโฟกัสอยู่ช่องไหน caret อยู่ไหน แล้วคืนให้หลังวาดเสร็จ
    var focus = captureRoleFocus();
    renderSockets();
    restoreRoleFocus(focus);
    renderBudget();
    requestAnimationFrame(drawCables);   // ต้องรู้ตำแหน่งกล่องจริงก่อนถึงลากสายได้
    if (el.count) {
      var n = 0;
      for (var i = 0; i < AGENTS.length; i++) n += listFor(AGENTS[i]).length;
      el.count.textContent = n;
      el.count.hidden = n === 0;
    }
  }

  /**
   * เอาค่าจาก state ใส่กลับช่องกรอก
   * ⚠️ ห้ามเขียนทับช่องที่กำลังพิมพ์อยู่ (document.activeElement) ไม่งั้น cursor เด้ง/ตัวหาย
   *    เคสจริง: save() เสร็จ -> render() -> ทับข้อความที่พิมพ์ต่อไปแล้ว
   */
  function syncJobInputs() {
    if (el.jobTitle && document.activeElement !== el.jobTitle) {
      el.jobTitle.value = data.state.job.title || "";
    }
    if (el.brief && document.activeElement !== el.brief) {
      el.brief.value = data.state.job.brief || "";
    }
    updateBriefCount();
  }

  function captureRoleFocus() {
    var a = document.activeElement;
    if (!a || !a.getAttribute) return null;
    // ครอบทั้งช่องหน้าที่และช่องลำดับ (ทั้งคู่ถูกสร้างใหม่ทุก render)
    var attr = a.getAttribute("data-role-agent") ? "data-role-agent"
             : a.getAttribute("data-order-agent") ? "data-order-agent" : null;
    if (!attr) return null;
    var f = { attr: attr, agent: a.getAttribute(attr), value: a.value, start: null, end: null };
    // input type=number ไม่รองรับ selectionStart -> อ่านแล้ว throw ต้องกัน
    try { f.start = a.selectionStart; f.end = a.selectionEnd; } catch (_) {}
    return f;
  }

  function restoreRoleFocus(f) {
    if (!f) return;
    var box = el.sockets.querySelector("[" + f.attr + '="' + cssEsc(f.agent) + '"]');
    if (!box) return;
    // ค่าที่ยังพิมพ์ไม่เสร็จต้องชนะค่าที่ server ตอบกลับมา (ไม่งั้นตัวอักษรล่าสุดหาย)
    if (f.value !== box.value) box.value = f.value;
    if (f.start == null) { try { box.focus({ preventScroll: true }); } catch (_) { box.focus(); } return; }
    // preventScroll สำคัญ: autosave ยิงทุก ~0.9 วิระหว่างพิมพ์ ถ้า focus แล้วเลื่อนจอตาม
    // แผงจะกระตุกขึ้นลงเองเรื่อยๆ (เห็นตอนเปิดภาพดู — assert จับไม่ได้)
    try { box.focus({ preventScroll: true }); } catch (_) { box.focus(); }
    try { box.setSelectionRange(f.start, f.end); } catch (_) {}
  }

  function updateBriefCount() {
    if (!el.briefCount || !el.brief) return;
    var n = (el.brief.value || "").length;
    var cap = data.briefBudget || 4000;
    el.briefCount.textContent = n ? n.toLocaleString() + " / " + cap.toLocaleString() : "0";
    el.briefCount.setAttribute("data-over", n > cap ? "true" : "false");
    updateLive();
  }

  /**
   * ไฟบอกว่า "ตอนนี้งานกำลังบังคับสายไหนอยู่จริง"
   * อ่านจาก verify (= ผลอ่านกลับจากไฟล์ปลายทาง) ไม่ใช่จากสิ่งที่พิมพ์ในช่อง
   * เจตนา: autosave มองไม่เห็น → ถ้าไม่มีตัวนี้ user จะไม่รู้ว่าส่งไปแล้วหรือยัง
   */
  function updateLive() {
    if (!el.live) return;
    if (!hasJob() && !anySkillPlugged()) {
      el.live.textContent = "ยังไม่ได้ส่งงาน";
      el.live.setAttribute("data-on", "false");
      return;
    }
    var on = [], wait = [];
    for (var i = 0; i < AGENTS.length; i++) {
      var a = AGENTS[i];
      if (a === "job") continue;
      var v = data.verify[a] || {};
      if (a === "antigravity") { if (v.needsPaste) wait.push("antigravity (รอวางบรีฟ)"); else if (v.ok) on.push(a); continue; }
      if (v.ok === false) continue;
      if (a === "claude" ? v.hookInstalled : v.blockPresent) on.push(a);
    }
    el.live.textContent = "กำลังบังคับอยู่: " + (on.length ? on.join(" · ") : "—") +
      (wait.length ? " · " + wait.join(" · ") : "");
    el.live.setAttribute("data-on", on.length ? "true" : "false");
  }

  /** จบงาน = ล้างบรีฟ/ชื่องาน/หน้าที่ แต่ **ไม่ถอดสกิล** (สกิลมีปุ่มถอดของตัวเองอยู่แล้ว) */
  function endJob() {
    if (!data.state) return;
    if (el.end.getAttribute("data-confirm") !== "1") {
      el.end.setAttribute("data-confirm", "1");
      el.end.textContent = "กดอีกครั้งเพื่อจบงาน";
      setTimeout(function () {
        if (!el.end) return;
        el.end.setAttribute("data-confirm", "0");
        el.end.textContent = "จบงาน";
      }, 2600);
      return;
    }
    el.end.setAttribute("data-confirm", "0");
    el.end.textContent = "จบงาน";
    data.state.job.title = "";
    data.state.job.brief = "";
    // ⚠️ ต้องล้าง order/lead ด้วย ไม่ใช่แค่ roles
    //    บั๊กที่เจอตอน regression: ล้างไม่ครบ -> hasJob() ยัง true -> ไฟยังติด
    //    = กด "จบงาน" แล้วงานไม่จบจริง แล้วบรีฟยังถูกส่งอยู่
    data.state.lead = "";
    for (var i = 0; i < AGENTS.length; i++) {
      if (AGENTS[i] === "job") continue;
      data.state.roles[AGENTS[i]] = "";
      data.state.order[AGENTS[i]] = 0;
    }
    if (el.jobTitle) el.jobTitle.value = "";
    if (el.brief) el.brief.value = "";
    saveNow();
  }

  function renderRack() {
    var rack = el.rack;
    rack.textContent = "";
    var q = (el.search.value || "").toLowerCase().trim();

    for (var i = 0; i < data.skills.length; i++) {
      var s = data.skills[i];
      // ค้นได้ทั้งชื่อไทย คำอธิบายไทย หมวด และ id/desc อังกฤษ (พิมพ์ "ดีไซน์" ต้องเจอ)
      if (q) {
        var hay = (s.id + " " + (s.nameTh || "") + " " + (s.descTh || "") + " " +
                   (s.use || "") + " " + (s.tag || "") + " " + (s.desc || "")).toLowerCase();
        if (hay.indexOf(q) < 0) continue;
      }

      var jack = document.createElement("div");
      jack.className = "pb-jack";
      jack.setAttribute("data-skill", s.id);
      jack.setAttribute("data-plugged", isPlugged(s.id) ? "true" : "false");
      if (s.tag) jack.setAttribute("data-tag", s.tag);
      // tooltip = ไทยก่อน (คนอ่าน) ถ้าไม่มีค่อยเป็นอังกฤษ
      jack.title = (s.descTh || s.desc || s.id) + (s.use ? "\n\nควรเสียบตอน: " + s.use : "");

      var head = document.createElement("div");
      head.className = "pb-jack-head";

      var plugIcon = document.createElement("span");
      plugIcon.className = "pb-jack-plug";
      plugIcon.setAttribute("aria-hidden", "true");
      head.appendChild(plugIcon);

      var name = document.createElement("span");
      name.className = "pb-jack-name";
      // ชื่อไทยเป็นตัวหลัก · id อังกฤษเป็นตัวรอง (ยังต้องเห็น เพราะมันคือชื่อจริงในไฟล์)
      name.textContent = s.nameTh || s.id;
      head.appendChild(name);

      if (s.star) {
        var st = document.createElement("span");
        st.className = "pb-jack-star";
        st.title = "เกี่ยวกับงานที่ทำอยู่จริงในเครื่องนี้ — เสียบตัวนี้ก่อนได้เลย";
        st.textContent = "ใช้บ่อย";
        head.appendChild(st);
      }
      if (s.tag) {
        var tg = document.createElement("span");
        tg.className = "pb-jack-tag";
        tg.textContent = s.tag;
        head.appendChild(tg);
      }

      // สกิลมาจากหลายที่ ไม่ใช่ ~/.claude/skills อย่างเดียว — บอกให้รู้ว่าตัวไหนมาจากไหน
      if (s.source && s.source !== "claude") {
        var src = document.createElement("span");
        src.className = "pb-jack-src";
        src.setAttribute("data-src", s.source);
        src.textContent = s.source === "repo" ? "เรโป" : "codex";
        head.appendChild(src);
      }

      var size = document.createElement("span");
      size.className = "pb-jack-size";
      size.textContent = kb(s.bytes) + " · ~" + tok(s.bytes).toLocaleString() + " tok";
      head.appendChild(size);

      jack.appendChild(head);

      // id อังกฤษ — ต้องยังเห็น เพราะเวลาคุยกับ AI หรือหาไฟล์ ใช้ชื่อนี้
      if (s.nameTh) {
        var idLine = document.createElement("code");
        idLine.className = "pb-jack-id";
        idLine.textContent = s.id;
        jack.appendChild(idLine);
      }

      var dText = s.descTh || s.desc;
      if (dText) {
        var d = document.createElement("p");
        d.className = "pb-jack-desc";
        // ไทยยาวได้กว่าเพราะอ่านเร็วกว่า keyword-stuffed อังกฤษ
        var cap = s.descTh ? 150 : 110;
        d.textContent = dText.length > cap ? dText.slice(0, cap) + "…" : dText;
        jack.appendChild(d);
      }

      // ตอบคำถาม "กูไม่รู้ว่าควรใส่อันไหน" ตรงๆ
      if (s.use) {
        var u = document.createElement("p");
        u.className = "pb-jack-use";
        u.textContent = "เสียบตอน: " + s.use;
        jack.appendChild(u);
      }

      if (!s.inCodex) {
        var w = document.createElement("span");
        w.className = "pb-jack-warn";
        w.textContent = "ยังไม่มีในฝั่ง Codex";
        jack.appendChild(w);
      }

      rack.appendChild(jack);
    }

    if (!rack.children.length) {
      var empty = document.createElement("p");
      empty.className = "pb-empty";
      empty.textContent = q ? "ไม่เจอสกิลที่ค้นหา" : "ไม่เจอสกิลใน ~/.claude/skills/";
      rack.appendChild(empty);
    }
  }

  function renderSockets() {
    var wrap = el.sockets;
    wrap.textContent = "";

    for (var i = 0; i < AGENTS.length; i++) {
      var agent = AGENTS[i];
      var meta = AGENT_META[agent];
      var v = data.verify[agent] || {};
      var ids = listFor(agent);

      var sock = document.createElement("section");
      sock.className = "pb-socket";
      sock.setAttribute("data-agent", agent);
      sock.setAttribute("data-verify", socketVerify(agent, v, ids));

      var head = document.createElement("header");
      head.className = "pb-socket-head";

      var lamp = document.createElement("span");
      lamp.className = "pb-lamp";
      lamp.setAttribute("aria-hidden", "true");
      head.appendChild(lamp);

      // ลำดับงาน — ตัวที่กันปัญหา "สายที่ควรรอ ลงมือก่อนคนที่มีหน้าที่คิด"
      if (agent !== "job") {
        var ord = document.createElement("input");
        ord.type = "number";
        ord.className = "pb-order";
        ord.min = "0"; ord.max = "99"; ord.step = "1";
        ord.setAttribute("data-order-agent", agent);
        ord.placeholder = "–";
        ord.title = "ลำดับการทำงาน (1 = ทำก่อน) · เว้นว่าง = ไม่ระบุลำดับ";
        var ov = orderFor(agent);
        ord.value = ov ? String(ov) : "";
        head.appendChild(ord);
      }

      var title = document.createElement("h3");
      title.className = "pb-socket-title";
      title.textContent = meta.label;
      head.appendChild(title);

      // ธงผู้คุมงาน — สายที่ติดธงจะได้หน้าที่ "ไปสั่ง/ทวงสายอื่นเอง ห้ามรอ user"
      if (agent !== "job") {
        var lead = document.createElement("button");
        lead.type = "button";
        lead.className = "pb-lead";
        lead.setAttribute("data-lead-agent", agent);
        var isLead = data.state.lead === agent;
        lead.setAttribute("data-on", isLead ? "true" : "false");
        lead.textContent = isLead ? "ผู้คุมงาน" : "ตั้งเป็นผู้คุมงาน";
        lead.title = isLead
          ? "สายนี้ถือหน้าที่ไปสั่ง/ทวงสายอื่นเอง (กดอีกครั้งเพื่อถอด)"
          : "ให้สายนี้เป็นคนคุมงาน — จะได้คำสั่งเพิ่มว่าต้องไปตามงานสายอื่นเอง";
        head.appendChild(lead);
      }

      var chars = charsFor(agent);
      if (chars) {
        var cost = document.createElement("span");
        cost.className = "pb-socket-cost";
        // จ่ายเต็มครั้งเดียวตอนเปิด session (หรือตอนเปลี่ยนปลั๊ก) รอบหลังเหลือบรรทัดเตือน
        cost.textContent = "~" + tok(chars).toLocaleString() + " tok ครั้งแรก";
        head.appendChild(cost);
      }
      sock.appendChild(head);

      var note = document.createElement("p");
      note.className = "pb-socket-note";
      note.textContent = verifyText(agent, v, ids);
      sock.appendChild(note);

      // หน้าที่ของสายนี้ในงานนี้ — ทุกสายจะเห็นผังนี้ทั้งหมด ไม่ใช่เห็นแค่บรรทัดของตัวเอง
      if (agent !== "job") {
        var role = document.createElement("input");
        role.type = "text";
        role.className = "pb-role";
        role.setAttribute("data-role-agent", agent);
        role.maxLength = data.roleMax || 400;
        role.placeholder = "หน้าที่ของตัวนี้ — เช่น " + (AGENT_META[agent].roleHint || "…");
        role.value = roleFor(agent);
        sock.appendChild(role);
      }

      var slots = document.createElement("div");
      slots.className = "pb-slots";

      // สกิลที่ไหลมาจาก "งานนี้" — ต้องโชว์ให้เห็นว่าสายนี้โดนบังคับอยู่จริง
      // ไม่งั้นช่องจะดูว่างเปล่าทั้งที่ AI ตัวนั้นถูกบังคับให้อ่านแล้ว = หลอกตาคนดู
      if (agent !== "job") {
        var inherited = listFor("job");
        for (var j = 0; j < inherited.length; j++) {
          if (ids.indexOf(inherited[j]) >= 0) continue;   // เสียบตรงด้วย = ไม่ต้องโชว์ซ้ำ
          var gchip = document.createElement("span");
          gchip.className = "pb-chip pb-chip--inherit";
          gchip.title = "มาจากช่อง “งานนี้ (ทุกสาย)” — ถอดได้ที่ช่องนั้น";
          gchip.textContent = inherited[j];
          slots.appendChild(gchip);
        }
      }

      for (var k = 0; k < ids.length; k++) {
        var s = skillById(ids[k]);
        var chip = document.createElement("span");
        chip.className = "pb-chip";
        chip.setAttribute("data-skill", ids[k]);
        chip.setAttribute("data-agent", agent);
        chip.appendChild(document.createTextNode(s ? s.id : ids[k]));

        var x = document.createElement("button");
        x.type = "button";
        x.className = "pb-chip-x";
        x.setAttribute("aria-label", "ถอด " + ids[k]);
        x.setAttribute("data-unplug", ids[k]);
        x.setAttribute("data-agent", agent);
        x.textContent = "×";
        chip.appendChild(x);

        slots.appendChild(chip);
      }

      if (!slots.children.length) {
        var hole = document.createElement("span");
        hole.className = "pb-hole";
        hole.textContent = "ลากสกิลมาเสียบ";
        slots.appendChild(hole);
      }
      sock.appendChild(slots);

      // Antigravity ยังไม่มี hook — ต้องก๊อปบรีฟไปวางเอง 1 ครั้ง พูดตรงๆ ไม่กลบ
      if (agent === "antigravity" && (ids.concat(listFor("job")).length || hasJob())) {
        var copy = document.createElement("button");
        copy.type = "button";
        copy.className = "pb-copy";
        copy.setAttribute("data-copy-brief", "1");
        copy.textContent = "ก๊อปบรีฟไปวางให้ Antigravity";
        sock.appendChild(copy);
      }

      wrap.appendChild(sock);
    }
  }

  function socketVerify(agent, v, ids) {
    if (!ids.length && !listFor("job").length && !hasJob()) return "idle";
    if (v.ok === false) return "fail";
    if (agent === "antigravity" && v.needsPaste) return "warn";
    if (agent === "claude" && v.hookInstalled === false) return "fail";
    return "ok";
  }

  function verifyText(agent, v, ids) {
    var meta = AGENT_META[agent];
    if (!ids.length && agent !== "job" && !listFor("job").length && !hasJob()) return meta.note;
    if (agent === "job") {
      if (ids.length) return "ทุกสายต้องอ่าน " + ids.length + " สกิลนี้" + (hasJob() ? " + บรีฟงาน" : "");
      return hasJob() ? "✓ บรีฟงานถูกส่งให้ทุกสายแล้ว" : meta.note;
    }
    if (v.ok === false) return "⚠ " + (v.reason || v.missing || "เขียนไม่สำเร็จ");
    if (agent === "claude") {
      return v.hookInstalled
        ? "✓ hook ติดตั้งแล้ว · " + (v.chars || 0).toLocaleString() + " ตัวอักษร/prompt (มีผลกับ session ใหม่)"
        : "⚠ ยังไม่ได้ติดตั้ง hook";
    }
    if (agent === "antigravity") {
      return v.chars
        ? "✓ เขียนไฟล์แล้ว " + v.chars.toLocaleString() + " ตัวอักษร — เหลือก๊อปบรีฟไปวาง 1 ครั้ง"
        : meta.note;
    }
    return v.blockPresent ? "✓ ฝังในไฟล์แล้ว (" + shortPath(v.target) + ")" : meta.note;
  }

  function shortPath(p) {
    if (!p) return "";
    var parts = String(p).split(/[\\/]/);
    return parts.slice(-2).join("/");
  }

  function renderBudget() {
    var worst = 0;
    for (var i = 0; i < AGENTS.length; i++) worst = Math.max(worst, charsFor(AGENTS[i]));
    var pct = Math.min(100, Math.round((worst / data.budget) * 100));
    el.budgetFill.style.width = pct + "%";
    el.budgetFill.setAttribute("data-over", worst > data.budget ? "true" : "false");
    if (worst) {
      el.budgetText.textContent =
        worst.toLocaleString() + " / " + data.budget.toLocaleString() + " ตัวอักษร · จ่าย ~" +
        tok(worst).toLocaleString() + " tok ครั้งเดียวตอนเปิด session · รอบถัดไปเหลือบรรทัดเตือน";
    } else if (hasJob()) {
      // บรีฟล้วนไม่มีสกิล — ต้องบอกราคาจริงของบรีฟ ไม่ใช่ "ยังไม่ได้เสียบอะไร" (ขัดกับสถานะข้างล่าง)
      var bc = (data.verify.claude && data.verify.claude.chars) || 0;
      el.budgetText.textContent = "บรีฟงาน " + bc.toLocaleString() + " ตัวอักษร (~" +
        tok(bc).toLocaleString() + " tok ครั้งแรก) · ยังไม่ได้เสียบสกิล";
    } else {
      el.budgetText.textContent = "ยังไม่ได้เสียบอะไร";
    }
    el.budgetWarn.hidden = worst <= data.budget;
  }

  /* ---------------------------------------------------------- cables */

  /** ลากสายจริงจากชั้นวาง → ช่องที่เสียบ (วาดหลัง layout เสมอ) */
  function drawCables() {
    var svg = el.cables;
    if (!svg) return;
    svg.textContent = "";
    var box = el.body.getBoundingClientRect();
    svg.setAttribute("viewBox", "0 0 " + box.width + " " + box.height);

    for (var i = 0; i < AGENTS.length; i++) {
      var agent = AGENTS[i];
      var ids = listFor(agent);
      for (var k = 0; k < ids.length; k++) {
        var jack = el.rack.querySelector('.pb-jack[data-skill="' + cssEsc(ids[k]) + '"]');
        var chip = el.sockets.querySelector(
          '.pb-chip[data-skill="' + cssEsc(ids[k]) + '"][data-agent="' + agent + '"]'
        );
        if (!jack || !chip) continue;   // สกิลถูกกรองออกด้วยช่องค้นหา = ไม่ต้องวาด
        var a = jack.getBoundingClientRect();
        var b = chip.getBoundingClientRect();
        var x1 = a.right - box.left, y1 = a.top + a.height / 2 - box.top;
        var x2 = b.left - box.left, y2 = b.top + b.height / 2 - box.top;

        // ชั้นวางเลื่อนได้ → สกิลที่ถูกเลื่อนพ้นกรอบจะลากสายทะลุออกนอกแผง
        // แก้: หนีบปลายสายไว้ที่ขอบชั้นวาง แล้วทำเป็นเส้นจางบอกว่า "ต่ออยู่ แต่อยู่นอกจอ"
        var rackBox = el.rack.getBoundingClientRect();
        var top = rackBox.top - box.top, bottom = rackBox.bottom - box.top;
        var off = y1 < top || y1 > bottom;
        if (off) y1 = Math.max(top + 2, Math.min(bottom - 2, y1));

        var dx = Math.max(40, (x2 - x1) * 0.5);

        var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("class", "pb-cable");
        path.setAttribute("data-agent", agent);
        if (off) path.setAttribute("data-offscreen", "true");
        path.setAttribute("d",
          "M" + x1 + " " + y1 + " C" + (x1 + dx) + " " + y1 + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2);
        svg.appendChild(path);
      }
    }
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, "\\$&"); }

  /* ------------------------------------------------------------- drag */

  function startDrag(e, skillId) {
    if (busy) return;
    drag = { skillId: skillId };
    el.body.setAttribute("data-dragging", "true");

    var ghost = document.createElement("div");
    ghost.className = "pb-ghost";
    ghost.textContent = skillId;
    document.body.appendChild(ghost);
    drag.ghost = ghost;

    var live = document.createElementNS("http://www.w3.org/2000/svg", "path");
    live.setAttribute("class", "pb-cable pb-cable--live");
    el.cables.appendChild(live);
    drag.live = live;

    var jack = el.rack.querySelector('.pb-jack[data-skill="' + cssEsc(skillId) + '"]');
    var r = jack.getBoundingClientRect();
    var box = el.body.getBoundingClientRect();
    drag.from = { x: r.right - box.left, y: r.top + r.height / 2 - box.top };

    moveDrag(e);
    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", endDrag);
  }

  function moveDrag(e) {
    if (!drag) return;
    drag.ghost.style.transform = "translate(" + (e.clientX + 12) + "px," + (e.clientY - 10) + "px)";

    var box = el.body.getBoundingClientRect();
    var x2 = e.clientX - box.left, y2 = e.clientY - box.top;
    var dx = Math.max(40, (x2 - drag.from.x) * 0.5);
    drag.live.setAttribute("d",
      "M" + drag.from.x + " " + drag.from.y +
      " C" + (drag.from.x + dx) + " " + drag.from.y + " " + (x2 - dx) + " " + y2 + " " + x2 + " " + y2);

    var over = socketUnder(e.clientX, e.clientY);
    var socks = el.sockets.querySelectorAll(".pb-socket");
    for (var i = 0; i < socks.length; i++) {
      socks[i].setAttribute("data-drop", socks[i] === over ? "true" : "false");
    }
  }

  function socketUnder(x, y) {
    var socks = el.sockets.querySelectorAll(".pb-socket");
    for (var i = 0; i < socks.length; i++) {
      var r = socks[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return socks[i];
    }
    return null;
  }

  function endDrag(e) {
    window.removeEventListener("pointermove", moveDrag);
    window.removeEventListener("pointerup", endDrag);
    if (!drag) return;

    var over = socketUnder(e.clientX, e.clientY);
    var socks = el.sockets.querySelectorAll(".pb-socket");
    for (var i = 0; i < socks.length; i++) socks[i].setAttribute("data-drop", "false");

    if (drag.ghost) drag.ghost.remove();
    if (drag.live) drag.live.remove();
    el.body.removeAttribute("data-dragging");
    var id = drag.skillId;
    drag = null;

    if (over) plug(id, over.getAttribute("data-agent"));
  }

  /* -------------------------------------------------------------- wire */

  function open() {
    el.panel.hidden = false;
    el.panel.setAttribute("data-open", "true");
    load();
  }
  function close() {
    el.panel.setAttribute("data-open", "false");
    el.panel.hidden = true;
  }

  function init() {
    el.panel = document.getElementById("pbPanel");
    if (!el.panel) return;
    el.body = document.getElementById("pbBody");
    el.rack = document.getElementById("pbRack");
    el.sockets = document.getElementById("pbSockets");
    el.cables = document.getElementById("pbCables");
    el.search = document.getElementById("pbSearch");
    el.status = document.getElementById("pbStatus");
    el.budgetFill = document.getElementById("pbBudgetFill");
    el.budgetText = document.getElementById("pbBudgetText");
    el.budgetWarn = document.getElementById("pbBudgetWarn");
    el.count = document.getElementById("pbCount");
    el.jobTitle = document.getElementById("pbJobTitle");
    el.brief = document.getElementById("pbBrief");
    el.briefCount = document.getElementById("pbBriefCount");
    el.live = document.getElementById("pbLive");
    el.send = document.getElementById("pbSend");
    el.end = document.getElementById("pbEnd");

    var openBtn = document.getElementById("pbOpen");
    if (openBtn) openBtn.addEventListener("click", open);
    var closeBtn = document.getElementById("pbClose");
    if (closeBtn) closeBtn.addEventListener("click", close);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && el.panel && !el.panel.hidden) close();
    });

    // ลากจากชั้นวาง
    el.rack.addEventListener("pointerdown", function (e) {
      var jack = e.target.closest ? e.target.closest(".pb-jack") : null;
      if (!jack) return;
      e.preventDefault();
      startDrag(e, jack.getAttribute("data-skill"));
    });

    // ถอดปลั๊ก
    el.sockets.addEventListener("click", function (e) {
      var x = e.target.closest ? e.target.closest("[data-unplug]") : null;
      if (x) { unplug(x.getAttribute("data-unplug"), x.getAttribute("data-agent")); return; }
      var c = e.target.closest ? e.target.closest("[data-copy-brief]") : null;
      if (c) copyBrief(c);
    });

    el.search.addEventListener("input", function () { renderRack(); requestAnimationFrame(drawCables); });

    var clearBtn = document.getElementById("pbClear");
    if (clearBtn) clearBtn.addEventListener("click", unplugAll);

    el.jobTitle.addEventListener("change", function () {
      if (!data.state) return;
      data.state.job.title = el.jobTitle.value;
      saveNow();
    });

    // บรีฟรวม — พิมพ์แล้วส่งเองหลังเงียบ ~0.9 วิ (และส่งทันทีตอนคลิกออก)
    if (el.brief) {
      el.brief.addEventListener("input", function () {
        if (!data.state) return;
        data.state.job.brief = el.brief.value;
        updateBriefCount();
        saveSoon();
      });
      el.brief.addEventListener("blur", function () {
        if (!data.state) return;
        data.state.job.brief = el.brief.value;
        saveNow();
      });
    }

    // ปุ่มสั่งส่งทันที (autosave ยังทำงานอยู่ ปุ่มนี้ไว้ให้เห็นว่า "สั่งแล้ว" ชัดๆ)
    if (el.send) {
      el.send.addEventListener("click", function () {
        if (!data.state) return;
        if (el.jobTitle) data.state.job.title = el.jobTitle.value;
        if (el.brief) data.state.job.brief = el.brief.value;
        var boxes = el.sockets.querySelectorAll("[data-role-agent]");
        for (var i = 0; i < boxes.length; i++) {
          data.state.roles[boxes[i].getAttribute("data-role-agent")] = boxes[i].value;
        }
        if (!hasJob() && !anySkillPlugged()) {
          setStatus("ยังไม่มีอะไรจะส่ง — พิมพ์บรีฟหรือเสียบสกิลก่อน", "warn");
          return;
        }
        saveNow();
      });
    }
    if (el.end) el.end.addEventListener("click", endJob);

    // ลำดับ + ธงผู้คุมงาน (ปุ่มถูกสร้างใหม่ทุก render → ดักที่ตัวแม่)
    el.sockets.addEventListener("click", function (e) {
      var lb = e.target.closest ? e.target.closest("[data-lead-agent]") : null;
      if (!lb || !data.state) return;
      var a = lb.getAttribute("data-lead-agent");
      data.state.lead = data.state.lead === a ? "" : a;   // กดซ้ำ = ถอดธง
      saveNow();
    });

    // หน้าที่รายตัว (ช่องถูกสร้างใหม่ทุกครั้งที่ render → ต้องดักที่ตัวแม่ ไม่ใช่ที่ input)
    el.sockets.addEventListener("input", function (e) {
      var ob = e.target.closest ? e.target.closest("[data-order-agent]") : null;
      if (ob && data.state) {
        var n = parseInt(ob.value, 10);
        data.state.order[ob.getAttribute("data-order-agent")] =
          Number.isFinite(n) && n > 0 && n < 100 ? n : 0;
        saveSoon(450);
        return;
      }
      var box = e.target.closest ? e.target.closest("[data-role-agent]") : null;
      if (!box || !data.state) return;
      data.state.roles[box.getAttribute("data-role-agent")] = box.value;
      saveSoon();
    });
    el.sockets.addEventListener("change", function (e) {
      var box = e.target.closest ? e.target.closest("[data-role-agent]") : null;
      if (!box || !data.state) return;
      data.state.roles[box.getAttribute("data-role-agent")] = box.value;
      saveNow();
    });

    window.addEventListener("resize", function () { requestAnimationFrame(drawCables); });
  }

  function copyBrief(btn) {
    // ใช้ข้อความที่ server ประกอบให้ (ตัวเดียวกับหน้า /anti) — คนละที่ต้องพูดเหมือนกัน
    var text = data.antiBrief ||
      ("ก่อนเริ่มงาน เปิดอ่านไฟล์นี้ให้จบก่อน แล้วทำตามมันเคร่งครัด: " + data.antiPath);
    var done = function () {
      btn.textContent = "ก๊อปแล้ว — เอาไปวางในช่องแชท Antigravity";
      setTimeout(function () { btn.textContent = "ก๊อปบรีฟไปวางให้ Antigravity"; }, 2600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else fallbackCopy(text, done);
  }

  function fallbackCopy(text, done) {
    var ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); done(); } catch (_) {}
    ta.remove();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();

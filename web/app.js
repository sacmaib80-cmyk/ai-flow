"use strict";
/* =========================================================================
   app.js — เลน Claude: state + layout + render
   ⚠️ ไม่ยุ่งกับสี/animation — แค่ set class + data-attribute + CSS variable
      ให้ theme.css (เลน Antigravity) เอาไปใช้
   สัญญาที่ให้ไว้:
     .wire[data-ch][data-state]  + style="--age: 0..1"
     .pulse[data-ch]
     .node[data-ch][data-state]
     .tape-row[data-ch]
   ========================================================================= */

(function () {
  var CH_ORDER = ["claude", "gateway", "telegram", "anti", "cron", "tasks"];

  var el = {
    root: document.getElementById("flowRoot"),
    wires: document.getElementById("wires"),
    nodes: document.getElementById("nodes"),
    hub: document.getElementById("hub"),
    hubHost: document.getElementById("hubHost"),
    tape: document.getElementById("tapeList"),
    clock: document.getElementById("rigClock"),
    statLive: document.getElementById("statLive"),
    statArmed: document.getElementById("statArmed"),
    statDead: document.getElementById("statDead"),
    connDot: document.querySelector(".rig-dot"),
    connWarn: document.getElementById("connWarn"),
    tabEvents: document.getElementById("tabEvents"),
    tabErrors: document.getElementById("tabErrors"),
    errBadge: document.getElementById("errBadge"),
    errList: document.getElementById("errList"),
    vRam: document.getElementById("vRam"),
    vRamFill: document.getElementById("vRamFill"),
    vAiFill: document.getElementById("vAiFill"),
    vFree: document.getElementById("vFree"),
    vAi: document.getElementById("vAi"),
    vTools: document.getElementById("vTools"),
    vTok: document.getElementById("vTok"),
    vDisk: document.getElementById("vDisk"),
    vDiskList: document.getElementById("vDiskList"),
    runList: document.getElementById("runList"),
    detail: document.getElementById("detail"),
    detailTitle: document.getElementById("detailTitle"),
    detailSub: document.getElementById("detailSub"),
    detailStats: document.getElementById("detailStats"),
    detailFeed: document.getElementById("detailFeed"),
    detailClose: document.getElementById("detailClose"),
  };

  var snapshot = null;
  var openCh = null;
  var nodeEls = {};   // ch -> element
  var wireEls = {};   // ch -> {path, pulse}
  var lastSeen = {};  // ch -> lastTs (ใช้จับ "มีของใหม่" เพื่อยิงพัลส์)

  /* ------------------------------------------------------------ utils */

  function ageText(ts) {
    if (!ts) return "ไม่เคย";
    var s = Math.round((Date.now() - ts) / 1000);
    if (s < 0) s = 0;
    if (s < 60) return s + " วิ";
    var m = Math.round(s / 60);
    if (m < 60) return m + " นาที";
    var h = m / 60;
    if (h < 48) return Math.round(h) + " ชม.";
    return Math.round(h / 24) + " วัน";
  }

  function timeText(ts) {
    if (!ts) return "--:--";
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  /**
   * ความเงียบ 0..1 (0 = เพิ่งวิ่ง, 1 = เงียบนาน) → theme ใช้ทำ decay
   * ⚠️ เพดานอยู่ที่ 0.82 ไม่ใช่ 1.0 โดยตั้งใจ:
   * เส้นที่เงียบนานมาก (copilot 10 วัน) เคยจางเหลือ opacity 0.12 = มองไม่เห็นเลย
   * ทั้งที่มันเป็น "ทางเชื่อมที่มีอยู่จริง แค่นานๆ ใช้ที" ไม่ใช่ทางที่ไม่มี
   * → ยกพื้นให้ยังเห็นโครงสร้างเสมอ (User สั่งเอง: "เส้นที่เงียบให้โชว์จางๆ ไว้")
   */
  function ageRatio(ts) {
    if (!ts) return 1;
    var mins = (Date.now() - ts) / 60000;
    var r = Math.log10(1 + Math.max(0, mins)) / Math.log10(1 + 180); // 3 ชม. = เต็ม
    return Math.max(0, Math.min(0.82, r));
  }

  function txt(s) { return document.createTextNode(String(s == null ? "" : s)); }

  /* ------------------------------------------------------- layout */

  /**
   * ผังตามเส้นทางจริง (ไม่ใช่ล้อจักรยานแล้ว)
   * จัดเป็น 4 คอลัมน์ ไล่ซ้าย→ขวา ตามทิศทางที่งานไหล:
   *   [จุดชนวน]   →  [ตัวกลาง]  →  [ประมวลผล/ส่งออก]  →  [ปลายทาง]
   *    cron            gateway        claude-cli            มือถือ
   *    tasks                          telegram
   *    claude-code  →  repo        →  antigravity
   */
  var COLS = {
    /* คอลัมน์ 0 = จุดชนวน (คนกด / ตัวตั้งเวลา) + สมองกลางที่ป้อนความรู้
       ⚠️ ลำดับแถวสำคัญ: วางให้ปลายทางของแต่ละตัวอยู่ "แถวใกล้กัน"
       ไม่งั้นเส้นต้องวิ่งทแยงยาวข้ามจอแล้วไปพาดทับการ์ดอื่น
       (copilot→repo เคยยาว 570px ตัดทะลุการ์ด Antigravity) */
    vscode:    { col: 0, row: -0.85 },
    cron:      { col: 0, row: 0.3 },
    tasks:     { col: 0, row: 1.45 },
    /* ปฏิทินข่าว = จุดชนวนของสายข่าว วางใต้ tasks (ปลายทางเดียวกัน = telegram) */
    ffcal:     { col: 0, row: 2.75 },
    brain:     { col: 0, row: 4.0 },
    copilot:   { col: 0, row: 5.3 },

    /* คอลัมน์ 1 = agent ที่ลงมือทำ (ตัวหลักของผัง) */
    codex:     { col: 1, row: -0.75 },
    gateway:   { col: 1, row: 0.35 },
    claude:    { col: 1, row: 1.72 },
    /* news-alert อยู่กลางทาง ffcal → telegram */
    news:      { col: 1, row: 2.9 },
    anti:      { col: 1, row: 4.2 },

    /* คอลัมน์ 2 = ท่อ/ที่เก็บ ที่ agent ทำงานผ่าน */
    claudecli: { col: 2, row: -0.95 },
    telegram:  { col: 2, row: 0.3 },
    repo:      { col: 2, row: 1.7 },
    mcp:       { col: 2, row: 4.0 },
    browser:   { col: 2, row: 5.3 },

    /* คอลัมน์ 3 = ปลายทาง */
    you:       { col: 3, row: 0.3 },
    studio:    { col: 3, row: 4.0 },
    web:       { col: 3, row: 5.3 },
  };

  /** จำนวนแถวที่ผังใช้จริง (ใช้หารพื้นที่แนวตั้ง) */
  var ROW_SPAN = 6.9;

  function computeLayout() {
    var bay = document.querySelector(".patchbay");
    if (!bay) return null;
    var w = bay.clientWidth, h = bay.clientHeight;
    if (!w || !h) return null;

    var padX = Math.min(150, w * 0.11);
    var padTop = 92;                 // เว้นให้ป้ายบอกขั้น (.stage)
    var padBottom = 104;             // เว้นให้แถบคำอธิบาย (.legend) ไม่ให้ทับการ์ด
    var usableW = w - padX * 2;
    var usableH = h - padTop - padBottom;

    var pts = {};
    for (var id in COLS) {
      var c = COLS[id];
      pts[id] = {
        x: padX + (c.col / 3) * usableW,
        y: padTop + ((c.row + 1.05) / ROW_SPAN) * usableH,
      };
    }
    return { w: w, h: h, pts: pts };
  }

  /**
   * ขนาดกล่องของแต่ละโหนด (ครึ่งกว้าง/ครึ่งสูง) — ใช้ถอยจุดปลายเส้น
   * ให้ไปหยุดที่ "ขอบกล่อง" ไม่ใช่ "กลางกล่อง"
   * ⚠️ ถ้าไม่ทำ เส้นจะมุดเข้าไปใต้การ์ด แล้วหัวลูกศรหายหมด (บั๊กที่เห็นตอนเรนเดอร์รอบแรก)
   */
  function boxOf(id) {
    var elx = nodeEls[id] || nodeEls["_" + id];
    if (elx && elx.offsetWidth) return { hw: elx.offsetWidth / 2, hh: elx.offsetHeight / 2 };
    return { hw: 62, hh: 26 };
  }

  /** ถอยจุดเข้า/ออกให้พ้นขอบกล่อง ตามทิศที่เส้นวิ่ง */
  function edgeAnchor(p, id, towards, gap) {
    var b = boxOf(id);
    var dx = towards.x - p.x, dy = towards.y - p.y;
    if (!dx && !dy) return { x: p.x, y: p.y };
    // หาว่าชนขอบแนวตั้งหรือแนวนอนก่อน
    var sx = dx ? (b.hw + gap) / Math.abs(dx) : Infinity;
    var sy = dy ? (b.hh + gap) / Math.abs(dy) : Infinity;
    var s = Math.min(sx, sy);
    return { x: p.x + dx * s, y: p.y + dy * s };
  }

  /** กล่องของทุกโหนดบนผัง (พิกัดใน svg) — ใช้เช็คว่าเส้นจะพาดทับใครไหม */
  function obstacleBoxes(skipA, skipB) {
    var svg = el.wires.getBoundingClientRect();
    var out = [];
    var all = el.nodes.querySelectorAll(".node,.waypoint");
    for (var i = 0; i < all.length; i++) {
      var n = all[i];
      var id = n.getAttribute("data-ch") || n.getAttribute("data-node");
      if (id === skipA || id === skipB) continue;
      var c = n.getBoundingClientRect();
      if (!c.width) continue;
      out.push({
        l: c.left - svg.left - 10, r: c.right - svg.left + 10,
        t: c.top - svg.top - 8, b: c.bottom - svg.top + 8,
      });
    }
    return out;
  }

  /** จุดนี้ทับกล่องไหนไหม */
  function hitsBox(x, y, boxes) {
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (x > b.l && x < b.r && y > b.t && y < b.b) return true;
    }
    return false;
  }

  /** สร้าง path เบซิเยร์จากจุดควบคุม แล้วเช็คว่าชนกล่องกี่จุด */
  function pathOf(a, b, c1y, c2y, bend) {
    return "M " + a.x.toFixed(1) + " " + a.y.toFixed(1) +
           " C " + (a.x + bend).toFixed(1) + " " + c1y.toFixed(1) +
           " " + (b.x - bend).toFixed(1) + " " + c2y.toFixed(1) +
           " " + b.x.toFixed(1) + " " + b.y.toFixed(1);
  }

  /** ประเมินว่า path นี้พาดทับกล่องกี่จุด (sample ตามเส้นเบซิเยร์) */
  function scorePath(a, b, c1y, c2y, bend, boxes) {
    var hits = 0;
    for (var t = 0.08; t <= 0.92; t += 0.04) {
      var mt = 1 - t;
      // cubic bezier: P0=a, P1=(a.x+bend,c1y), P2=(b.x-bend,c2y), P3=b
      var x = mt * mt * mt * a.x + 3 * mt * mt * t * (a.x + bend) +
              3 * mt * t * t * (b.x - bend) + t * t * t * b.x;
      var y = mt * mt * mt * a.y + 3 * mt * mt * t * c1y +
              3 * mt * t * t * c2y + t * t * t * b.y;
      if (hitsBox(x, y, boxes)) hits++;
    }
    return hits;
  }

  /**
   * เส้นโค้งระหว่าง 2 จุด — "ไหลไปทางขวา" และ **อ้อมไม่ให้พาดทับการ์ดอื่น**
   *
   * ⚠️ เดิมวาดเส้นตรงๆ ไม่สนว่าจะทับใคร → เส้นยาวๆ อย่าง copilot→repo (570px)
   * ตัดทะลุกลางการ์ด Antigravity ทำให้ผังดูรกและ "ชี้ไม่ตรง"
   * → ตอนนี้ลองหลายทางโค้งแล้วเลือกทางที่ชนน้อยสุด
   */
  function edgePath(a, b, fromId, toId) {
    var dx = b.x - a.x;
    var bend = Math.max(26, Math.abs(dx) * 0.4);
    var lift = dx < 0 ? -52 : 0;   // เส้นย้อนกลับ อ้อมขึ้นบนเสมอ

    var boxes = obstacleBoxes(fromId, toId);
    if (!boxes.length) return pathOf(a, b, a.y + lift, b.y + lift, bend);

    /* ทางเลือก: ตรงก่อน แล้วค่อยอ้อมทีละนิด
       ⚠️ จำกัดแค่ 2 ระดับ (45/85px) โดยตั้งใจ — เคยลองอ้อมได้ถึง 260px
       ผลคือเส้นกวาดเป็นวงใหญ่ข้ามครึ่งจอ **ซึ่งดูแย่กว่าปล่อยให้ทับนิดหน่อย**
       หลักการ: เส้นที่อ่านง่ายสำคัญกว่าเส้นที่ไม่ทับอะไรเลย */
    var cands = [[a.y + lift, b.y + lift, bend]];
    var arc = [50, 95, 145];
    for (var i = 0; i < arc.length; i++) {
      cands.push([a.y - arc[i], b.y - arc[i], bend]);
      cands.push([a.y + arc[i], b.y + arc[i], bend]);
    }

    var best = cands[0], bestScore = Infinity;
    for (var j = 0; j < cands.length; j++) {
      var s = scorePath(a, b, cands[j][0], cands[j][1], cands[j][2], boxes);
      // ค่าปรับการอ้อม (จูนแล้ว): ต่ำไป=เส้นกวาดเป็นวงใหญ่ · สูงไป=ยอมทับหมด
      // 0.25 = ยอมอ้อมถ้าช่วยลดการทับได้จริง แต่ไม่อ้อมเพื่อจุดเดียว
      s += j * 0.25;
      if (s < bestScore) { bestScore = s; best = cands[j]; }
      if (bestScore <= 0.25) break;
    }
    return pathOf(a, b, best[0], best[1], best[2]);
  }

  /* ------------------------------------------------------- render */

  function render() {
    if (!snapshot) return;
    var L = computeLayout();
    if (!L) return;

    el.hub.style.display = "none"; // ไม่ใช้ hub กลางแล้ว — gateway คือตัวกลางจริง

    var counts = { live: 0, armed: 0, dead: 0, idle: 0 };
    var SVGNS = "http://www.w3.org/2000/svg";

    /* ---- 1) วาดเส้นทางจริงจาก topology ----
       ⚠️ ต้องวาด "หลัง" การ์ดถูกสร้างแล้ว เพราะต้องรู้ขนาดกล่องจริง
       เพื่อถอยปลายเส้นไปหยุดที่ขอบ → drawEdges() ถูกเรียกท้าย render() */

    /* ---- 2) โหนดที่ไม่ใช่ "สาย" (claude-cli / repo / มือถือ) ---- */
    (snapshot.nodes || []).forEach(function (n) {
      if (n.kind === "channel") return; // พวกนี้วาดเป็นการ์ดข้างล่าง
      var p = L.pts[n.id];
      if (!p) return;
      var box = nodeEls["_" + n.id];
      if (!box) {
        box = document.createElement("div");
        box.className = "waypoint";
        box.setAttribute("data-node", n.id);
        box.innerHTML = '<span class="wp-name"></span><span class="wp-sub"></span>';
        el.nodes.appendChild(box);
        nodeEls["_" + n.id] = box;
      }
      box.style.left = p.x + "px";
      box.style.top = p.y + "px";
      box.querySelector(".wp-name").textContent = n.label || n.id;
      box.querySelector(".wp-sub").textContent = n.sub || "";
    });

    snapshot.channels.forEach(function (c) {
      counts[c.state] = (counts[c.state] || 0) + 1;
      var p = L.pts[c.ch];
      if (!p) return;

      /* ---- การ์ดโหนด ---- */
      var node = nodeEls[c.ch];
      if (!node) {
        node = document.createElement("article");
        node.className = "node";
        node.setAttribute("data-ch", c.ch);
        node.setAttribute("tabindex", "0");
        node.setAttribute("role", "button");
        node.addEventListener("click", function () { openDetail(c.ch); });
        node.addEventListener("keydown", function (e) {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openDetail(c.ch); }
        });
        node.innerHTML =
          '<div class="node-head">' +
            '<span class="node-icon" data-ch="' + c.ch + '"></span>' +
            '<h2 class="node-name"></h2>' +
            '<span class="node-state"></span>' +
          '</div>' +
          '<p class="node-sub"></p>' +
          '<p class="node-stat"></p>' +
          '<p class="node-stat2"></p>' +
          '<p class="node-age"></p>';
        el.nodes.appendChild(node);
        nodeEls[c.ch] = node;
      }
      node.style.left = p.x + "px";
      node.style.top = p.y + "px";
      node.setAttribute("data-state", c.state);
      // น้ำหนักการแสดงผลตามความสำคัญ: 1=agent เต็มตัว 2=ผู้ช่วย 3=ท่อ/ทางเชื่อม
      node.setAttribute("data-tier", c.tier || 3);
      node.style.setProperty("--age", ageRatio(c.lastTs).toFixed(3));
      node.querySelector(".node-name").textContent = c.label || c.ch;
      node.querySelector(".node-state").textContent = stateLabel(c.state);
      node.querySelector(".node-sub").textContent = c.sub || "";
      node.querySelector(".node-stat").textContent = c.stat || "";
      node.querySelector(".node-stat2").textContent = c.note || c.stat2 || "";
      node.querySelector(".node-age").textContent = c.lastTs ? ("ล่าสุด " + ageText(c.lastTs) + "ที่แล้ว") : "ไม่มีสัญญาณ";
    });

    el.statLive.textContent = counts.live || 0;
    el.statArmed.textContent = counts.armed || 0;
    el.statDead.textContent = (counts.dead || 0) + (counts.idle || 0);
    el.root.setAttribute("data-live", counts.live > 0 ? "true" : "false");

    drawEdges(L);   // วาดเส้นท้ายสุด ตอนนี้รู้ขนาดกล่องจริงแล้ว
    renderTape();
    renderErrors();
    renderVitals();
    if (openCh) fillDetail(openCh);
  }

  /* ---------------- รายการที่พัง ---------------- */

  function renderErrors() {
    var e = snapshot.errors || { items: [], recent: 0 };

    if (e.recent > 0) {
      el.errBadge.hidden = false;
      el.errBadge.textContent = e.recent;
    } else {
      el.errBadge.hidden = true;
    }

    el.errList.textContent = "";
    if (!e.items.length) {
      var li0 = document.createElement("li");
      li0.className = "tape-empty";
      li0.appendChild(txt("ไม่มีอะไรพังในช่วงที่ตรวจได้"));
      el.errList.appendChild(li0);
      return;
    }

    e.items.forEach(function (it) {
      var li = document.createElement("li");
      li.className = "tape-row err-row";
      li.setAttribute("data-ch", it.ch);
      li.setAttribute("data-level", it.level);

      var time = document.createElement("span");
      time.className = "tape-time";
      time.appendChild(txt(timeText(it.ts)));

      var body = document.createElement("span");
      body.className = "tape-text";

      var head = document.createElement("b");
      head.className = "err-where";
      head.appendChild(txt(it.where || it.ch));
      body.appendChild(head);
      body.appendChild(txt(" " + it.text));
      if (it.count > 1) {
        var rep = document.createElement("i");
        rep.className = "err-count";
        rep.appendChild(txt(" ×" + it.count));
        body.appendChild(rep);
      }

      li.appendChild(time);
      li.appendChild(body);
      el.errList.appendChild(li);
    });
  }

  /* ---------------- ภาระเครื่อง ---------------- */

  function renderVitals() {
    var v = snapshot.vitals;
    if (!v) return;

    // ตัวเลขหลัก = RAM ของเครื่องจริง (ตรงกับ Task Manager)
    el.vRam.textContent = v.ram.usedGb.toFixed(1) + " / " + v.ram.totalGb.toFixed(1) + " GB  ·  " + v.ram.usedPct + "%";
    el.vFree.textContent = v.ram.freeGb.toFixed(1) + " GB";
    el.vAi.textContent = v.ram.toolsGb.toFixed(1) + " GB  (" + v.ram.toolsShare + "% ของที่ใช้)";

    var usedPct = Math.min(100, v.ram.usedPct);
    var aiPct = Math.min(100, (v.ram.toolsGb / v.ram.totalGb) * 100);
    el.vRamFill.style.width = usedPct.toFixed(1) + "%";
    el.vAiFill.style.width = aiPct.toFixed(1) + "%";
    // เตือนตามภาระเครื่องจริง (เกณฑ์เดียวกับที่คนดู Task Manager ใช้)
    el.vRamFill.setAttribute("data-load", usedPct > 85 ? "high" : (usedPct > 65 ? "mid" : "low"));

    el.vTools.textContent = "";
    (v.ram.byTool || []).slice(0, 4).forEach(function (t) {
      var li = document.createElement("li");
      li.appendChild(txt(t.name + " · " + (t.mb >= 1024 ? (t.mb / 1024).toFixed(1) + "GB" : t.mb + "MB")));
      el.vTools.appendChild(li);
    });

    var tk = v.tokens || {};
    el.vTok.textContent = tk.output
      ? (tk.output >= 1000 ? Math.round(tk.output / 1000) + "k" : tk.output) + " out"
      : "—";

    var totalDisk = (v.disk || []).reduce(function (s, d) { return s + d.mb; }, 0);
    el.vDisk.textContent = totalDisk >= 1024
      ? (totalDisk / 1024).toFixed(1) + " GB"
      : totalDisk + " MB";

    // แจกแจงว่าใครกินดิสก์เท่าไหร่ (ตัวที่โตเรื่อยๆ คือ transcript)
    el.vDiskList.textContent = "";
    (v.disk || []).slice(0, 4).forEach(function (d) {
      var li = document.createElement("li");
      li.appendChild(txt(d.name + " · " + (d.mb >= 1024 ? (d.mb / 1024).toFixed(1) + "GB" : d.mb + "MB")));
      el.vDiskList.appendChild(li);
    });

    renderRunning();
  }

  /** เปิดค้างอยู่ตอนนี้ (จาก process จริง) */
  function renderRunning() {
    var list = snapshot.running || [];
    el.runList.textContent = "";
    if (!list.length) {
      var li0 = document.createElement("li");
      li0.className = "run-empty";
      li0.appendChild(txt("ไม่มีอะไรเปิดค้าง"));
      el.runList.appendChild(li0);
      return;
    }
    list.forEach(function (p) {
      var li = document.createElement("li");
      li.className = "run-row";
      var dot = document.createElement("span");
      dot.className = "run-dot";
      var name = document.createElement("span");
      name.className = "run-name";
      name.appendChild(txt(p.name));
      var age = document.createElement("span");
      age.className = "run-age";
      age.appendChild(txt(p.started ? ageText(p.started) : ""));
      li.appendChild(dot);
      li.appendChild(name);
      li.appendChild(age);
      el.runList.appendChild(li);
    });
  }

  /* ---------------- สลับแท็บ ---------------- */

  function showTab(which) {
    var isErr = which === "errors";
    el.tape.hidden = isErr;   // el.tape = #tapeList (ระวังชื่อไม่ตรงกัน)
    el.errList.hidden = !isErr;
    el.tabEvents.classList.toggle("is-on", !isErr);
    el.tabErrors.classList.toggle("is-on", isErr);
    el.tabEvents.setAttribute("aria-selected", String(!isErr));
    el.tabErrors.setAttribute("aria-selected", String(isErr));
  }
  el.tabEvents.addEventListener("click", function () { showTab("events"); });
  el.tabErrors.addEventListener("click", function () { showTab("errors"); });

  /** วาดเส้นทางทั้งหมด — ปลายเส้นหยุดที่ขอบกล่อง ไม่มุดใต้การ์ด */
  function drawEdges(L) {
    var SVGNS = "http://www.w3.org/2000/svg";
    (snapshot.edges || []).forEach(function (e) {
      var pa = L.pts[e.from], pb = L.pts[e.to];
      if (!pa || !pb) return;

      var wire = wireEls[e.id];
      if (!wire) {
        var path = document.createElementNS(SVGNS, "path");
        path.setAttribute("class", "wire");
        var pulse = document.createElementNS(SVGNS, "circle");
        pulse.setAttribute("class", "pulse");
        pulse.setAttribute("r", "3.5");
        el.wires.appendChild(path);
        el.wires.appendChild(pulse);
        wire = wireEls[e.id] = { path: path, pulse: pulse };
      }

      var f = (snapshot.flow || {})[e.id];
      var chColor = e.from === "repo" ? "claude" : e.from;
      /**
       * เกณฑ์ความสว่างของเส้น
       * ⚠️ เดิมตั้ง flowing = ภายใน 10 นาที ซึ่ง "โกหก" สำหรับงานที่รันเป็นรอบ:
       * cron รันสำเร็จเมื่อ 34 นาทีก่อน (25 ครั้ง) แต่เส้นจางเหมือนใกล้ตาย
       * → ขยายเป็น 60 นาที = "เพิ่งทำงานจริงในชั่วโมงนี้"
       */
      var st = "never";
      if (f) {
        var mins = (Date.now() - f.lastTs) / 60000;
        st = !f.ok ? "error" : (mins < 60 ? "flowing" : "quiet");
      }

      // ถอยปลายทั้งสองข้างให้พ้นกล่อง (เว้นช่องให้หัวลูกศรโผล่)
      var a = edgeAnchor(pa, e.from, pb, 4);
      var b = edgeAnchor(pb, e.to, pa, 9);

      var d = edgePath(a, b, e.from, e.to);
      wire.path.setAttribute("d", d);
      wire.path.setAttribute("data-ch", chColor);
      wire.path.setAttribute("data-flow", st);
      wire.path.setAttribute("data-kind", e.kind);
      if (e.inferred) wire.path.setAttribute("data-inferred", "true");
      wire.path.style.setProperty("--age", f ? ageRatio(f.lastTs).toFixed(3) : "1");

      wire.pulse.setAttribute("data-ch", chColor);
      wire.pulse.setAttribute("data-flow", st);
      wire.pulse.style.offsetPath = 'path("' + d + '")';

      var seenKey = "e:" + e.id;
      if (f && lastSeen[seenKey] && f.lastTs > lastSeen[seenKey]) {
        wire.path.classList.remove("wire--fire");
        void wire.path.getBoundingClientRect();
        wire.path.classList.add("wire--fire");
      }
      if (f) lastSeen[seenKey] = f.lastTs;
    });
  }

  function stateLabel(s) {
    return s === "live" ? "มีสัญญาณ"
         : s === "armed" ? "ตั้งรออยู่"
         : s === "idle" ? "เงียบ"
         : "ไม่ทำงาน";
  }

  function renderTape() {
    var rows = (snapshot.tape || []).slice(0, 40);
    el.tape.textContent = "";
    rows.forEach(function (t) {
      var li = document.createElement("li");
      li.className = "tape-row";
      li.setAttribute("data-ch", t.ch);
      var time = document.createElement("span");
      time.className = "tape-time";
      time.appendChild(txt(timeText(t.ts)));
      var text = document.createElement("span");
      text.className = "tape-text";
      text.appendChild(txt(t.text));
      li.appendChild(time);
      li.appendChild(text);
      el.tape.appendChild(li);
    });
  }

  /* ------------------------------------------------------- detail */

  function openDetail(ch) {
    openCh = ch;
    el.detail.hidden = false;
    fillDetail(ch);
  }

  function fillDetail(ch) {
    var c = (snapshot.channels || []).filter(function (x) { return x.ch === ch; })[0];
    if (!c) return;
    el.detail.setAttribute("data-ch", ch);
    el.detail.setAttribute("data-state", c.state);
    el.detailTitle.textContent = c.label || ch;
    el.detailSub.textContent = c.sub || "";

    el.detailStats.textContent = "";
    var pairs = [
      ["สถานะ", stateLabel(c.state)],
      ["สัญญาณล่าสุด", c.lastTs ? ageText(c.lastTs) + "ที่แล้ว" : "ไม่เคย"],
      ["", c.stat],
      ["", c.stat2],
    ];
    if (c.schedule) pairs.push(["ตารางเวลา", c.schedule]);
    if (c.note) pairs.push(["หมายเหตุ", c.note]);
    pairs.forEach(function (p) {
      if (!p[1]) return;
      var dt = document.createElement("dt"); dt.appendChild(txt(p[0]));
      var dd = document.createElement("dd"); dd.appendChild(txt(p[1]));
      el.detailStats.appendChild(dt); el.detailStats.appendChild(dd);
    });

    el.detailFeed.textContent = "";
    (c.feed || []).forEach(function (f) {
      var li = document.createElement("li");
      if (f.ok === false) li.setAttribute("data-ok", "false");
      li.appendChild(txt(timeText(f.ts) + "  " + f.text));
      el.detailFeed.appendChild(li);
    });
  }

  el.detailClose.addEventListener("click", function () {
    el.detail.hidden = true;
    openCh = null;
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && !el.detail.hidden) { el.detail.hidden = true; openCh = null; }
  });

  /* ------------------------------------------------------- transport */

  function setConn(ok) {
    el.connDot.setAttribute("data-conn", ok ? "on" : "off");
    el.connWarn.hidden = !!ok;
    if (ok) {
      el.connWarn.textContent = "ขาดการเชื่อมต่อกับ server — กำลังต่อใหม่…";
    }
  }

  /**
   * ถ้า server ยังไม่ขึ้น (หรือเพิ่งรีสตาร์ต) ให้บอกวิธีแก้แบบชัดๆ
   * แทนที่จะปล่อยให้หน้าเว็บค้างเปล่าๆ จนคนดูไม่รู้ว่าต้องทำอะไร
   */
  function showServerDown(tries) {
    el.connWarn.hidden = false;
    el.connWarn.textContent = tries > 3
      ? "ยังต่อ server ไม่ได้ — เปิด \"8 - AI Flow\" บน Desktop แล้วอย่าปิดหน้าต่างดำ (หน้านี้จะต่อเองอัตโนมัติ)"
      : "ขาดการเชื่อมต่อกับ server — กำลังต่อใหม่…";
  }

  function applySnapshot(d) {
    snapshot = d;
    if (d.host) el.hubHost.textContent = d.host;
    render();
  }

  /**
   * ต่อ WebSocket แล้ว **ต่อใหม่เองเรื่อยๆ ถ้าหลุด**
   * เพื่อให้ปิด/เปิด server ใหม่แล้วหน้าเว็บกลับมาเองโดยไม่ต้องรีเฟรช
   */
  var wsTries = 0;
  function connect() {
    var ws;
    try {
      ws = new WebSocket("ws://" + location.host);
    } catch (e) {
      wsTries++; showServerDown(wsTries);
      return setTimeout(connect, 2000);
    }

    ws.onopen = function () { wsTries = 0; setConn(true); };
    ws.onmessage = function (ev) {
      try {
        var msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") applySnapshot(msg.data);
      } catch (_) {}
    };
    ws.onclose = function () {
      wsTries++;
      setConn(false);
      showServerDown(wsTries);
      // ต่อถี่ตอนแรก แล้วค่อยห่างออก (สูงสุด 5 วิ) กันยิงรัวเปล่าๆ
      setTimeout(connect, Math.min(1000 + wsTries * 500, 5000));
    };
    ws.onerror = function () { try { ws.close(); } catch (_) {} };
  }

  // เผื่อ ws ใช้ไม่ได้ → ดึงผ่าน HTTP
  function pollFallback() {
    fetch("/api/snapshot").then(function (r) { return r.json(); })
      .then(function (d) { applySnapshot(d); setConn(true); })
      .catch(function () { setConn(false); });
  }

  /* ------------------------------------------------------- boot */

  function tickClock() {
    var d = new Date();
    el.clock.textContent =
      String(d.getHours()).padStart(2, "0") + ":" +
      String(d.getMinutes()).padStart(2, "0") + ":" +
      String(d.getSeconds()).padStart(2, "0");
  }

  window.addEventListener("resize", function () { render(); });

  pollFallback();          // ให้เห็นของทันทีไม่ต้องรอ ws
  connect();
  setInterval(tickClock, 1000); tickClock();
  setInterval(function () { if (snapshot) render(); }, 15000); // อัปเดตข้อความ "ล่าสุด N นาที"

  // เผื่อ debug จาก console
  window._flow = {
    get snapshot() { return snapshot; },
    render: render,
    layout: computeLayout,
  };
})();

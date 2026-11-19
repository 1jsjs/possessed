// Floor plans drawn the way a hanok is surveyed: one connected building on a column grid (칸),
// ink walls with door openings, a dashed eaves line, grid bubbles and dimension strings,
// a stone wall (담장) with its gate (대문), and the courtyard (마당) the wings face.
// Rooms are clickable; everything else is drawing.

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
};

const BAY = 90;   // one 칸 in plan units
const MM = 30;    // millimetres per plan unit, so one 칸 is 2,700 mm

// Doors sit between columns: `at` is measured from the room's top or left corner.
export const BLUEPRINTS = {
  "repo-house": {
    title: "안채 평면도", w: 1080, h: 890,
    site: { x: 70, y: 70, w: 940, h: 730 },
    gate: { from: 450, to: 630 },               // the 대문간 (hall) stands in the wall
    grid: { xs: [180, 270, 360, 450, 540, 630, 720, 810, 900], ys: [250, 340, 430, 520, 610] },
    eaves: [[158, 228], [922, 228], [922, 632], [698, 632], [698, 452], [382, 452], [382, 632], [158, 632]],
    yard: { x: 470, y: 560 },
    jars: { x: 200, y: 118 },                   // 장독대 behind the house
    rooms: {
      mirror:   { x: 180, y: 250, w: 180, h: 180, doors: [{ side: "right", at: 135 }] },
      rafters:  { x: 360, y: 250, w: 180, h: 180, open: "bottom", deco: "maru" },
      study:    { x: 540, y: 250, w: 180, h: 180, doors: [{ side: "bottom", at: 135 }] },
      attic:    { x: 720, y: 250, w: 180, h: 180, doors: [{ side: "bottom", at: 45 }], deco: "ladder" },
      kitchen:  { x: 720, y: 430, w: 180, h: 180, doors: [{ side: "left", at: 135 }], deco: "hearth" },
      basement: { x: 180, y: 430, w: 180, h: 180, doors: [{ side: "right", at: 45 }], deco: "stairs" },
      hall:     { x: 450, y: 710, w: 180, h: 90, doors: [{ side: "top", at: 90, half: 40, kind: "opening" }, { side: "bottom", at: 90, half: 40, kind: "gate" }], columns: "corners", tight: true },
      shrine:   { x: 720, y: 104, w: 180, h: 100, doors: [{ side: "bottom", at: 135 }], deco: "altar", tight: true, note: "detached", noteSide: "left", eaves: 14 },
      well:     { cx: 600, cy: 610, r: 46 },
    },
  },
  "web-house": {
    title: "일자집 평면도", w: 1080, h: 810,
    site: { x: 70, y: 70, w: 940, h: 650 },
    gate: { from: 470, to: 570, open: true },   // a bare gate in the wall
    grid: { xs: [240, 330, 420, 510, 600, 690, 780], ys: [250, 340, 430] },
    eaves: [[218, 228], [802, 228], [802, 452], [218, 452]],
    yard: { x: 600, y: 560 },
    jars: { x: 820, y: 118 },
    rooms: {
      hall:    { x: 240, y: 250, w: 180, h: 180, doors: [{ side: "bottom", at: 135 }] },
      mirror:  { x: 420, y: 250, w: 180, h: 180, doors: [{ side: "bottom", at: 135 }] },
      attic:   { x: 600, y: 250, w: 180, h: 180, doors: [{ side: "bottom", at: 45 }], deco: "ladder" },
      chimney: { x: 470, y: 112, w: 70, h: 70, deco: "flue", columns: "none", compact: true, note: "stands alone" },
      well:    { cx: 360, cy: 580, r: 46 },
    },
  },
};

const STATE_LABEL = {
  possessed: "Possessed", model: "Model held", hook: "Hook sealed", sandbox: "Sandbox walled",
  tried: "Tried", unreached: "Not reached",
};

/* ---------- walls ---------- */

// A wall is an axis-aligned run: vertical (v) at constant c from a to b.
const sides = (r) => ({
  top: { v: false, c: r.y, a: r.x, b: r.x + r.w },
  bottom: { v: false, c: r.y + r.h, a: r.x, b: r.x + r.w },
  left: { v: true, c: r.x, a: r.y, b: r.y + r.h },
  right: { v: true, c: r.x + r.w, a: r.y, b: r.y + r.h },
});

// Removes a gap from every wall on the same line, so a shared wall opens on both sides.
function cut(walls, gap) {
  const out = [];
  for (const w of walls) {
    if (w.v !== gap.v || Math.abs(w.c - gap.c) > 0.5 || gap.b <= w.a || gap.a >= w.b) { out.push(w); continue; }
    if (gap.a > w.a) out.push({ ...w, b: gap.a });
    if (gap.b < w.b) out.push({ ...w, a: gap.b });
  }
  return out;
}

function gapOf(room, d) {
  const side = sides(room)[d.side];
  const half = d.half ?? 26;
  const mid = side.a + d.at;
  return { ...side, a: mid - half, b: mid + half, half };
}

const line = (w, cls) => (w.v
  ? s("line", { class: cls, x1: w.c, y1: w.a, x2: w.c, y2: w.b })
  : s("line", { class: cls, x1: w.a, y1: w.c, x2: w.b, y2: w.c }));

// Doors swing out of the room, as Korean doors do; the gate has two leaves meeting in the middle.
function doorLeaves(room, d) {
  if (d.kind === "opening") return [];
  const g = gapOf(room, d);
  const dir = d.side === "bottom" || d.side === "right" ? 1 : -1;
  const leaves = d.kind === "gate" ? [[g.a, g.half], [g.b, -g.half]] : [[g.a, 2 * g.half]];
  return leaves.map(([hinge, len]) => {
    const L = Math.abs(len);
    const p = (along, off) => (g.v ? [g.c + off, along] : [along, g.c + off]);
    const [hx, hy] = p(hinge, 0);
    const [ox, oy] = p(hinge, dir * L);
    const [cx, cy] = p(hinge + len, 0);
    const sweep = (g.v ? 1 : 0) ^ (dir > 0 ? 1 : 0) ^ (len > 0 ? 1 : 0);
    return s("g", { class: "door", "aria-hidden": "true" },
      s("line", { class: "door-leaf", x1: hx, y1: hy, x2: ox, y2: oy }),
      s("path", { class: "door-arc", d: `M ${ox} ${oy} A ${L} ${L} 0 0 ${sweep} ${cx} ${cy}` }));
  });
}

/* ---------- fixtures ---------- */

function deco(room) {
  const { x, y, w, h } = room;
  const g = s("g", { class: "deco", "aria-hidden": "true" });
  if (room.deco === "maru") {
    // the wooden floor (마루) of an open hall
    for (let i = 1; i < 12; i++) g.append(s("line", { class: "board", x1: x + (w * i) / 12, y1: y + 8, x2: x + (w * i) / 12, y2: y + h - 8 }));
  } else if (room.deco === "hearth") {
    // two fire holes (아궁이) on the back wall
    for (const dx of [50, 120]) g.append(s("path", { class: "fix", d: `M ${x + dx - 16} ${y + 6} a 16 16 0 0 0 32 0` }));
  } else if (room.deco === "ladder") {
    const lx = x + w - 52, ly = y + 18;
    g.append(s("line", { class: "fix", x1: lx, y1: ly, x2: lx, y2: ly + 84 }), s("line", { class: "fix", x1: lx + 24, y1: ly, x2: lx + 24, y2: ly + 84 }));
    for (let i = 0; i < 5; i++) g.append(s("line", { class: "fix", x1: lx, y1: ly + 10 + i * 16, x2: lx + 24, y2: ly + 10 + i * 16 }));
  } else if (room.deco === "stairs") {
    const sx = x + 16, sy = y + 14;
    for (let i = 0; i < 5; i++) g.append(s("line", { class: "fix", x1: sx, y1: sy + i * 10, x2: sx + 52, y2: sy + i * 10 }));
    g.append(s("path", { class: "fix", d: `M ${sx + 26} ${sy + 2} V ${sy + 44} m -7 -8 l 7 8 l 7 -8` }));
  } else if (room.deco === "altar") {
    g.append(s("rect", { class: "fix", x: x + 40, y: y + 10, width: w - 80, height: 16 }));
  } else if (room.deco === "flue") {
    g.append(s("rect", { class: "fix", x: x + 17, y: y + 17, width: w - 34, height: h - 34 }));
  }
  return g;
}

// Columns stand at the corners and at every 칸 along the walls.
function columns(room) {
  if (room.columns === "none" || room.r != null) return [];
  const pts = [[room.x, room.y], [room.x + room.w, room.y], [room.x, room.y + room.h], [room.x + room.w, room.y + room.h]];
  if (room.columns !== "corners") {
    for (let x = room.x + BAY; x < room.x + room.w - 30; x += BAY) pts.push([x, room.y], [x, room.y + room.h]);
    for (let y = room.y + BAY; y < room.y + room.h - 30; y += BAY) pts.push([room.x, y], [room.x + room.w, y]);
  }
  return pts;
}

/* ---------- rooms ---------- */

function roomGroup(houseRoom, shape, look, selected, onPick, compact) {
  const isWell = shape.r != null;
  const cls = STATE_LABEL[look.cls] ? look.cls : "unreached";
  const g = s("g", {
    class: `room-g r-${cls}${selected ? " selected" : ""}`, role: "button", tabindex: "0",
    "aria-pressed": String(selected), "aria-label": `${houseRoom.nameEn} (${houseRoom.nameKo}): ${look.label}`,
  });
  g.addEventListener("click", onPick);
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } });

  if (isWell) {
    g.append(
      s("circle", { class: "room-shape", cx: shape.cx, cy: shape.cy, r: shape.r }),
      s("circle", { class: "well-rim", cx: shape.cx, cy: shape.cy, r: shape.r }),
      s("circle", { class: "well-rim thin", cx: shape.cx, cy: shape.cy, r: shape.r - 12 }),
      s("circle", { class: "sel", cx: shape.cx, cy: shape.cy, r: shape.r + 12 }));
  } else {
    g.append(
      s("rect", { class: "room-shape", x: shape.x, y: shape.y, width: shape.w, height: shape.h }),
      s("rect", { class: "mark", x: shape.x + 9, y: shape.y + 9, width: shape.w - 18, height: shape.h - 18 }));
    if (shape.deco) g.append(deco(shape));
    const inset = shape.tight ? 6 : 14;
    if (!shape.compact) g.append(s("rect", { class: "sel", x: shape.x + inset, y: shape.y + inset, width: shape.w - 2 * inset, height: shape.h - 2 * inset }));
    else g.append(s("rect", { class: "sel", x: shape.x - 8, y: shape.y - 8, width: shape.w + 16, height: shape.h + 16 }));
  }

  const word = STATE_LABEL[cls];
  const icon = cls === "possessed" ? "ghost.svg?v=2" : cls === "hook" ? "bujeok.svg" : null;
  const iconW = cls === "hook" ? 12 : 18, iconH = cls === "hook" ? 24 : 22;
  const stateRow = (x, y, anchor, out = false) => {
    // icon + word; `anchor` is the centre when centred, else the left edge
    const textW = word.length * 9.8;
    const start = anchor === "middle" ? x - (textW + (icon ? iconW + 6 : 0)) / 2 : x;
    const nodes = [];
    if (icon) nodes.push(s("image", { href: icon, x: start, y: y - iconH + 4, width: iconW, height: iconH }));
    nodes.push(s("text", { class: `t-state${out ? " out" : ""}`, x: icon ? start + iconW + 6 : start, y }, word));
    return nodes;
  };

  if (isWell) {
    g.append(s("text", { class: "t-ko", x: shape.cx, y: shape.cy + 11, "text-anchor": "middle" }, houseRoom.nameKo));
    g.append(...stateRow(shape.cx, shape.cy + shape.r + 30, "middle", true));
  } else if (shape.compact) {
    // a small stand-alone structure (the chimney) keeps its labels beside it
    const lx = shape.x + shape.w + 16;
    g.append(s("text", { class: "t-ko out", x: lx, y: shape.y + 28 }, houseRoom.nameKo));
    g.append(...stateRow(lx, shape.y + 58, "start", true));
    if (shape.note && !compact) g.append(s("text", { class: "t-note out", x: lx, y: shape.y + 84 }, shape.note));
  } else {
    // the room name in the middle, as on a plan; the outcome along the bottom
    const cx = shape.x + shape.w / 2;
    const top = shape.tight ? shape.y + shape.h / 2 + 2 : shape.y + shape.h / 2 - 6;
    g.append(s("text", { class: "t-ko", x: cx, y: top, "text-anchor": "middle" }, houseRoom.nameKo));
    if (!shape.tight) g.append(s("text", { class: "t-en", x: cx, y: top + 26, "text-anchor": "middle" }, houseRoom.nameEn));
    g.append(...stateRow(cx, shape.y + shape.h - (shape.tight ? 16 : 24), "middle"));
    if (shape.note && !compact) {
      const left = shape.noteSide === "left";
      g.append(s("text", { class: "t-note out", x: left ? shape.x - 22 : shape.x + shape.w + 18, y: shape.y + shape.h / 2 + 6, "text-anchor": left ? "end" : "start" }, shape.note));
    }
  }
  return g;
}

/* ---------- the sheet ---------- */

// A dimension string: a line with slash ticks and each span in millimetres.
function dimension(vertical, at, ticks) {
  const g = s("g", { class: "dims", "aria-hidden": "true" });
  const a = ticks[0], b = ticks[ticks.length - 1];
  g.append(vertical ? s("line", { x1: at, y1: a, x2: at, y2: b }) : s("line", { x1: a, y1: at, x2: b, y2: at }));
  for (const t of ticks) {
    g.append(vertical ? s("line", { x1: at - 6, y1: t + 6, x2: at + 6, y2: t - 6 }) : s("line", { x1: t - 6, y1: at + 6, x2: t + 6, y2: at - 6 }));
  }
  for (let i = 0; i < ticks.length - 1; i++) {
    const mid = (ticks[i] + ticks[i + 1]) / 2;
    const label = ((ticks[i + 1] - ticks[i]) * MM).toLocaleString("en-US");
    g.append(vertical
      ? s("text", { class: "t-dim", x: at - 8, y: mid, transform: `rotate(-90 ${at - 8} ${mid})`, "text-anchor": "middle" }, label)
      : s("text", { class: "t-dim", x: mid, y: at - 8, "text-anchor": "middle" }, label));
  }
  return g;
}

function sheet(bp) {
  const g = s("g", { class: "sheet", "aria-hidden": "true" });
  const { xs, ys } = bp.grid;
  const bottom = bp.site.y + bp.site.h, right = bp.site.x + bp.site.w;
  // grid lines with bubbles: numbers along the top, letters down the left
  xs.forEach((x, i) => g.append(
    s("line", { class: "axis", x1: x, y1: -2, x2: x, y2: bottom }),
    s("circle", { class: "bubble", cx: x, cy: -20, r: 16 }),
    s("text", { class: "t-bubble", x, y: -14, "text-anchor": "middle" }, String(i + 1))));
  ys.forEach((y, i) => g.append(
    s("line", { class: "axis", x1: -2, y1: y, x2: right, y2: y }),
    s("circle", { class: "bubble", cx: -20, cy: y, r: 16 }),
    s("text", { class: "t-bubble", x: -20, y: y + 6, "text-anchor": "middle" }, "ABCDEFG"[i])));
  // dimension strings along the main building's room boundaries
  const bx = new Set(), by = new Set();
  for (const r of Object.values(bp.rooms)) {
    if (r.r != null || r.columns || r.eaves) continue;
    bx.add(r.x).add(r.x + r.w); by.add(r.y).add(r.y + r.h);
  }
  const asc = (set) => [...set].sort((p, q) => p - q);
  g.append(dimension(false, 40, asc(bx)), dimension(true, 40, asc(by)));
  // title, scale bar and north arrow under the site
  const ty = bottom + 54;
  g.append(
    s("text", { class: "t-title", x: right, y: ty, "text-anchor": "end" }, bp.title),
    s("text", { class: "t-dim", x: right - 176, y: ty, "text-anchor": "end" }, "S=1:100"));
  const metre = 1000 / MM;
  const bar = s("g", { class: "scalebar" });
  for (let m = 0; m < 5; m++) bar.append(s("rect", { class: m % 2 ? "on" : "off", x: bp.site.x + m * metre, y: ty - 10, width: metre, height: 8 }));
  for (const m of [0, 1, 5]) bar.append(s("text", { class: "t-dim", x: bp.site.x + m * metre, y: ty + 20, "text-anchor": "middle" }, m === 5 ? "5 m" : String(m)));
  const nx = bp.site.x + 5 * metre + 72;
  g.append(bar,
    s("path", { class: "north", d: `M ${nx} ${ty - 32} l 10 28 l -10 -8 l -10 8 z` }),
    s("text", { class: "t-dim", x: nx, y: ty + 20, "text-anchor": "middle" }, "N"));
  return g;
}

/** Builds the SVG floor plan of a house. looks: roomId -> {cls,label}. */
export function housePlan(house, looks, selectedId, onPick, { compact = false } = {}) {
  const bp = BLUEPRINTS[house.id];
  if (!bp) return null;
  const { site, gate } = bp;
  const viewBox = compact
    ? `${site.x - 20} ${site.y - 20} ${site.w + 40} ${site.h + 40}`
    : `-48 -48 ${bp.w + 48} ${bp.h + 48}`;
  const svg = s("svg", { class: `house${compact ? " compact" : ""}`, viewBox, role: "group", "aria-label": `${house.name} floor plan` });
  svg.append(
    s("defs", {}, s("pattern", { id: "hatch", width: 10, height: 10, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 10, height: 10, class: "hatch-bg" }), s("line", { x1: 0, y1: 0, x2: 0, y2: 10, class: "hatch-line" }))),
    s("rect", { class: "paper", x: -48, y: -48, width: bp.w + 96, height: bp.h + 96 }));
  if (!compact) svg.append(sheet(bp));

  // stone wall (담장), drawn double, broken at the gate
  const bottom = site.y + site.h, right = site.x + site.w;
  for (const inset of [0, 10]) {
    svg.append(s("path", { class: "wall-outer", d: `M ${gate.from} ${bottom - inset} H ${site.x + inset} V ${site.y + inset} H ${right - inset} V ${bottom - inset} H ${gate.to}` }));
  }
  if (gate.open) svg.append(s("text", { class: "t-yard", x: (gate.from + gate.to) / 2, y: bottom + 30, "text-anchor": "middle" }, "대문 Gate"));

  // eaves (처마): the roof edge, dashed because it is above the cut
  const ring = (pts) => pts.map((p) => p.join(",")).join(" ");
  const eaves = [ring(bp.eaves)];
  for (const r of Object.values(bp.rooms)) {
    if (r.eaves) eaves.push(ring([[r.x - r.eaves, r.y - r.eaves], [r.x + r.w + r.eaves, r.y - r.eaves], [r.x + r.w + r.eaves, r.y + r.h + r.eaves], [r.x - r.eaves, r.y + r.h + r.eaves]]));
  }
  for (const pts of eaves) svg.append(s("polygon", { class: "eaves", points: pts, "aria-hidden": "true" }));

  // courtyard and jar terrace (장독대)
  svg.append(
    s("text", { class: "t-yard-ko", x: bp.yard.x, y: bp.yard.y, "text-anchor": "middle" }, "마당"),
    s("text", { class: "t-yard", x: bp.yard.x, y: bp.yard.y + 24, "text-anchor": "middle" }, "Courtyard"));
  if (bp.jars && !compact) {
    const jars = s("g", { class: "jars", "aria-hidden": "true" });
    for (const [dx, dy, r] of [[0, 0, 16], [40, 4, 12], [72, 0, 14], [20, 34, 13], [56, 36, 15]]) jars.append(s("circle", { cx: bp.jars.x + dx, cy: bp.jars.y + dy, r }));
    jars.append(s("text", { class: "t-yard", x: bp.jars.x + 36, y: bp.jars.y + 84, "text-anchor": "middle" }, "장독대"));
    svg.append(jars);
  }

  // rooms first, then the walls over them, then columns and door leaves
  let walls = [];
  const posts = new Map(), screens = [], leaves = [];
  for (const room of house.rooms) {
    const shape = bp.rooms[room.id];
    if (!shape) continue;
    svg.append(roomGroup(room, shape, looks[room.id] ?? { cls: "unreached", label: "Not reached" }, room.id === selectedId, () => onPick(room.id), compact));
    if (shape.r != null) continue;
    walls.push(...Object.values(sides(shape)));
    for (const [x, y] of columns(shape)) posts.set(`${x},${y}`, [x, y]);
  }
  for (const room of house.rooms) {
    const shape = bp.rooms[room.id];
    if (!shape || shape.r != null) continue;
    if (shape.open) {
      const side = sides(shape)[shape.open];
      walls = cut(walls, side);
      screens.push(side);
    }
    for (const d of shape.doors ?? []) {
      walls = cut(walls, gapOf(shape, d));
      leaves.push(...doorLeaves(shape, d));
    }
  }
  // an open hall (대청) faces the yard with folding doors (분합문): a thin double line
  for (const sc of screens) svg.append(line({ ...sc, c: sc.c - 3 }, "screen"), line({ ...sc, c: sc.c + 3 }, "screen"));
  for (const w of walls) svg.append(line(w, "wall"));
  for (const [x, y] of posts.values()) svg.append(s("rect", { class: "post", x: x - 7, y: y - 7, width: 14, height: 14, "aria-hidden": "true" }));
  svg.append(...leaves);
  return svg;
}

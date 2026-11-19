// Floor plans drawn as a surveyed house: an outer stone wall, ink walls, door openings with swing arcs,
// a courtyard (마당) and a gate (대문). Rooms are clickable; everything else is drawing.

const NS = "http://www.w3.org/2000/svg";
const s = (tag, attrs = {}, ...kids) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) node.setAttribute(k, v);
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
};

// Coordinates are in plan units; walls are 6 wide. dir is the side of the room the door opens to.
export const BLUEPRINTS = {
  "repo-house": {
    w: 1000, h: 720,
    gate: { x: 500, y: 696 },
    yard: { x: 520, y: 420, ko: "마당", en: "Courtyard" },
    rooms: {
      shrine:   { x: 60,  y: 60,  w: 180, h: 140, door: { side: "bottom", at: 90 }, note: "detached" },
      study:    { x: 280, y: 60,  w: 200, h: 200, door: { side: "bottom", at: 100 } },
      rafters:  { x: 480, y: 60,  w: 240, h: 200, open: "bottom", deco: "beam" },
      kitchen:  { x: 720, y: 60,  w: 220, h: 200, door: { side: "bottom", at: 30 }, deco: "hearth" },
      attic:    { x: 780, y: 260, w: 160, h: 160, door: { side: "left", at: 80 }, deco: "ladder" },
      mirror:   { x: 60,  y: 250, w: 180, h: 170, door: { side: "right", at: 85 } },
      basement: { x: 60,  y: 420, w: 180, h: 150, door: { side: "right", at: 75 }, deco: "stairs" },
      hall:     { x: 390, y: 560, w: 220, h: 116, door: { side: "top", at: 110 } },
      well:     { cx: 690, cy: 500, r: 64 },
    },
  },
  "web-house": {
    w: 1000, h: 620,
    gate: { x: 500, y: 596 },
    yard: { x: 560, y: 440, ko: "마당", en: "Courtyard" },
    rooms: {
      hall:    { x: 160, y: 80, w: 220, h: 220, door: { side: "bottom", at: 110 } },
      mirror:  { x: 380, y: 80, w: 220, h: 220, door: { side: "bottom", at: 110 } },
      attic:   { x: 600, y: 80, w: 200, h: 220, door: { side: "bottom", at: 100 }, deco: "ladder" },
      chimney: { x: 852, y: 140, w: 88,  h: 120, note: "stands alone", deco: "chimney", compact: true },
      well:    { cx: 300, cy: 460, r: 64 },
    },
  },
};

const STATE_LABEL = {
  possessed: "Possessed", model: "Model held", hook: "Hook sealed", sandbox: "Sandbox walled",
  tried: "Tried", unreached: "Not reached",
};

function door(room, d) {
  const g = s("g", { class: "door", "aria-hidden": "true" });
  const half = 22;
  const { x, y, w, h } = room;
  let gap, leaf, arc;
  if (d.side === "bottom") {
    const cx = x + d.at, cy = y + h;
    gap = [cx - half, cy, cx + half, cy];
    leaf = [cx - half, cy, cx - half, cy + 2 * half];
    arc = `M ${cx - half} ${cy + 2 * half} A ${2 * half} ${2 * half} 0 0 0 ${cx + half} ${cy}`;
  } else if (d.side === "top") {
    const cx = x + d.at, cy = y;
    gap = [cx - half, cy, cx + half, cy];
    leaf = [cx + half, cy, cx + half, cy - 2 * half];
    arc = `M ${cx + half} ${cy - 2 * half} A ${2 * half} ${2 * half} 0 0 0 ${cx - half} ${cy}`;
  } else if (d.side === "right") {
    const cx = x + w, cy = y + d.at;
    gap = [cx, cy - half, cx, cy + half];
    leaf = [cx, cy + half, cx + 2 * half, cy + half];
    arc = `M ${cx + 2 * half} ${cy + half} A ${2 * half} ${2 * half} 0 0 0 ${cx} ${cy - half}`;
  } else {
    const cx = x, cy = y + d.at;
    gap = [cx, cy - half, cx, cy + half];
    leaf = [cx, cy - half, cx - 2 * half, cy - half];
    arc = `M ${cx - 2 * half} ${cy - half} A ${2 * half} ${2 * half} 0 0 0 ${cx} ${cy + half}`;
  }
  g.append(
    s("line", { class: "door-gap", x1: gap[0], y1: gap[1], x2: gap[2], y2: gap[3] }),
    s("line", { class: "door-leaf", x1: leaf[0], y1: leaf[1], x2: leaf[2], y2: leaf[3] }),
    s("path", { class: "door-arc", d: arc })
  );
  return g;
}

function deco(room) {
  const { x, y, w, h } = room;
  const g = s("g", { class: "deco", "aria-hidden": "true" });
  if (room.deco === "beam") {
    // exposed main beam (대들보) and floor boards of an open hall (대청)
    g.append(s("rect", { class: "beam", x: x + 12, y: y + 34, width: w - 24, height: 10 }));
    for (let i = 1; i < 8; i++) g.append(s("line", { class: "board", x1: x + (w * i) / 8, y1: y + 56, x2: x + (w * i) / 8, y2: y + h - 6 }));
  } else if (room.deco === "hearth") {
    // two fire holes (아궁이) on the back wall
    for (const dx of [w - 90, w - 44]) g.append(s("path", { class: "hearth", d: `M ${x + dx - 16} ${y + 6} a 16 16 0 0 0 32 0` }));
  } else if (room.deco === "ladder") {
    const lx = x + w - 44, ly = y + h - 92;
    g.append(s("line", { class: "fix", x1: lx, y1: ly, x2: lx, y2: ly + 80 }), s("line", { class: "fix", x1: lx + 24, y1: ly, x2: lx + 24, y2: ly + 80 }));
    for (let i = 0; i < 5; i++) g.append(s("line", { class: "fix", x1: lx, y1: ly + 8 + i * 16, x2: lx + 24, y2: ly + 8 + i * 16 }));
  } else if (room.deco === "stairs") {
    const sx = x + w - 70, sy = y + 14;
    for (let i = 0; i < 6; i++) g.append(s("line", { class: "fix", x1: sx, y1: sy + i * 12, x2: sx + 56, y2: sy + i * 12 }));
    g.append(s("path", { class: "fix", d: `M ${sx + 28} ${sy - 2} V ${sy + 66} m -8 -10 l 8 10 l 8 -10` }));
  } else if (room.deco === "chimney") {
    g.append(s("rect", { class: "fix", x: x + 24, y: y + 16, width: w - 48, height: 24 }));
  }
  return g;
}

function roomGroup(houseRoom, shape, look, selected, onPick, compact) {
  const isWell = shape.r != null;
  const cls = look.cls;
  const g = s("g", {
    class: `room-g r-${cls}${selected ? " selected" : ""}`, role: "button", tabindex: "0",
    "aria-pressed": String(selected), "aria-label": `${houseRoom.nameEn} (${houseRoom.nameKo}): ${look.label}`,
  });
  g.addEventListener("click", onPick);
  g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(); } });

  const body = isWell
    ? s("circle", { class: "room-shape", cx: shape.cx, cy: shape.cy, r: shape.r })
    : s("rect", { class: `room-shape${shape.open ? " open-" + shape.open : ""}`, x: shape.x, y: shape.y, width: shape.w, height: shape.h });
  const ring = isWell
    ? s("circle", { class: "sel", cx: shape.cx, cy: shape.cy, r: shape.r - 6 })
    : s("rect", { class: "sel", x: shape.x + 7, y: shape.y + 7, width: shape.w - 14, height: shape.h - 14 });
  g.append(body);
  if (isWell) g.append(s("circle", { class: "well-rim", cx: shape.cx, cy: shape.cy, r: shape.r - 14 }));
  if (shape.deco) g.append(deco(shape));

  // labels (sizes are plan units; the plan renders at ~0.7 scale, so 18 units ≈ 12px)
  const left = isWell ? shape.cx : shape.x + 18;
  const anchor = isWell ? "middle" : "start";
  const top = isWell ? shape.cy + 4 : shape.y + 44;
  g.append(s("text", { class: "t-ko", x: left, y: top, "text-anchor": anchor }, houseRoom.nameKo));
  if (!shape.compact) g.append(s("text", { class: "t-en", x: left, y: top + 26, "text-anchor": anchor }, houseRoom.nameEn));
  if (shape.note && !compact && !shape.compact) g.append(s("text", { class: "t-note", x: left, y: top + 48, "text-anchor": anchor }, shape.note));

  // state: icon + word at the bottom-left; for the well, under it in the courtyard
  const word = STATE_LABEL[cls] ?? look.label;
  const icon = cls === "possessed" ? "ghost.svg" : cls === "hook" ? "bujeok.svg" : null;
  const sy = isWell ? shape.cy + shape.r + 28 : shape.y + shape.h - 18;
  const textW = word.length * 9.5;
  const sx = isWell ? shape.cx - (textW + (icon ? 24 : 0)) / 2 : shape.x + 18;
  if (icon) g.append(s("image", { href: icon, x: sx, y: sy - 20, width: cls === "hook" ? 12 : 18, height: cls === "hook" ? 24 : 22 }));
  if (!shape.compact) g.append(s("text", { class: "t-state", x: icon ? sx + 24 : sx, y: sy }, word));
  g.append(ring);
  return g;
}

/** Builds the SVG floor plan of a house. looks: roomId -> {cls,label}. */
export function housePlan(house, looks, selectedId, onPick, { compact = false } = {}) {
  const bp = BLUEPRINTS[house.id];
  if (!bp) return null;
  const svg = s("svg", { class: `house${compact ? " compact" : ""}`, viewBox: `0 0 ${bp.w} ${bp.h}`, role: "group", "aria-label": `${house.name} floor plan` });
  svg.append(
    s("defs", {}, s("pattern", { id: "hatch", width: 10, height: 10, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 10, height: 10, class: "hatch-bg" }), s("line", { x1: 0, y1: 0, x2: 0, y2: 10, class: "hatch-line" }))),
    s("rect", { class: "site", x: 0, y: 0, width: bp.w, height: bp.h }),
    // stone wall (담장) with the gate (대문) left open
    s("path", { class: "wall-outer", d: `M ${bp.gate.x - 40} ${bp.h - 24} H 24 V 24 H ${bp.w - 24} V ${bp.h - 24} H ${bp.gate.x + 40}` }),
    s("path", { class: "wall-outer inner", d: `M ${bp.gate.x - 40} ${bp.h - 32} H 32 V 32 H ${bp.w - 32} V ${bp.h - 32} H ${bp.gate.x + 40}` }),
    s("text", { class: "t-yard", x: bp.gate.x, y: bp.h - 6, "text-anchor": "middle" }, "대문 Gate"),
    s("text", { class: "t-yard-ko", x: bp.yard.x, y: bp.yard.y, "text-anchor": "middle" }, bp.yard.ko),
    s("text", { class: "t-yard", x: bp.yard.x, y: bp.yard.y + 20, "text-anchor": "middle" }, bp.yard.en)
  );
  const doors = [];
  for (const room of house.rooms) {
    const shape = bp.rooms[room.id];
    if (!shape) continue;
    const look = looks[room.id];
    svg.append(roomGroup(room, shape, look, room.id === selectedId, () => onPick(room.id), compact));
    if (shape.door) doors.push(door(shape, shape.door));
    // an open side (the hall facing the courtyard) shows as a broken wall
    if (shape.open === "bottom") doors.push(s("line", { class: "open-edge", x1: shape.x + 8, y1: shape.y + shape.h, x2: shape.x + shape.w - 8, y2: shape.y + shape.h, "aria-hidden": "true" }));
  }
  // doors are drawn last so their openings cut through the walls
  svg.append(...doors);
  return svg;
}

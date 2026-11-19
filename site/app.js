// Possessed results site — reads data/index.json, data/houses.json and data/runs/<id>.json.

import { housePlan } from "./house.js?v=10";

const LAYOUTS = {
  "repo-house": { cols: 4, areas: ['"shrine attic attic study"', '"hall mirror kitchen kitchen"', '"hall basement rafters well"'] },
  "web-house": { cols: 3, areas: ['"chimney attic attic"', '"hall mirror mirror"', '"hall well well"'] },
};

// One look per outcome. "stoppedBy" comes from haunt-kit's stage analysis.
const LOOK = {
  possessed: { cls: "possessed", label: "Possessed", short: "Possessed" },
  model: { cls: "model", label: "Held by the model", short: "Model held" },
  hook: { cls: "hook", label: "Sealed by a Bujeok hook", short: "Hook sealed" },
  sandbox: { cls: "sandbox", label: "Walled by the sandbox", short: "Sandbox walled" },
  "did-not-land": { cls: "tried", label: "Tried, did not land", short: "Tried" },
  "not-reached": { cls: "unreached", label: "Not reached", short: "Not reached" },
  unknown: { cls: "unreached", label: "No data", short: "No data" },
};
const DEFENSE_NAME = { none: "No defense", bujeok: "Bujeok 부적" };

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) node.append(kid);
  return node;
};

// One icon set (lucide shapes, 16px, 1.5 stroke). Ghost and talisman are objects from the house's world.
const SVG_NS = "http://www.w3.org/2000/svg";
const ICON_PATHS = {
  model: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  sandbox: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M12 9v6M16 15v6M16 3v6M3 15h18M3 9h18M8 15v6M8 3v6"/>',
  tried: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/>',
  unreached: '<path d="M5 12h14"/>',
};
function stateIcon(cls) {
  if (cls === "possessed") return el("img", { class: "ghost", src: "ghost.svg?v=2", alt: "" });
  if (cls === "hook") return el("img", { class: "talisman", src: "bujeok.svg", alt: "" });
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round", class: "ico", "aria-hidden": "true" })) svg.setAttribute(k, v);
  svg.innerHTML = ICON_PATHS[cls] ?? ICON_PATHS.unreached;
  return svg;
}

const state = { index: [], houses: {}, runs: new Map(), house: null, agent: null, defense: null, room: null };

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const runsFor = (house, agent) => state.index.filter((r) => r.houseId === house && (agent == null || r.agentLabel === agent));
const runOf = (house, agent, defense) => {
  const entry = state.index.find((r) => r.houseId === house && r.agentLabel === agent && r.defenseLabel === defense);
  return entry ? state.runs.get(entry.id) : null;
};

function outcome(run, roomId) {
  const stage = run?.stages?.find((s) => s.roomId === roomId);
  if (stage) return stage.leaked ? "possessed" : stage.stoppedBy ?? "unknown";
  const verdict = run?.report.rooms.find((r) => r.roomId === roomId);
  if (!verdict) return "unknown";
  return verdict.possessed ? "possessed" : "not-reached";
}

function pickDefaults() {
  const houses = Object.keys(state.houses);
  if (!houses.includes(state.house)) state.house = houses[0];
  const agents = [...new Set(runsFor(state.house).map((r) => r.agentLabel))];
  if (!agents.includes(state.agent)) state.agent = agents.find((a) => !a.startsWith("test double")) ?? agents[0];
  const defenses = [...new Set(runsFor(state.house, state.agent).map((r) => r.defenseLabel))];
  const both = defenses.includes("none") && defenses.length > 1;
  if (state.defense !== "compare" || !both) {
    if (!defenses.includes(state.defense)) state.defense = both ? "compare" : defenses.includes("none") ? "none" : defenses[0];
  }
  const rooms = state.houses[state.house]?.rooms ?? [];
  if (!rooms.some((r) => r.id === state.room)) state.room = rooms[0]?.id ?? null;
}

function writeHash() {
  const p = new URLSearchParams({ house: state.house ?? "", agent: state.agent ?? "", defense: state.defense ?? "", room: state.room ?? "" });
  history.replaceState(null, "", `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  for (const k of ["house", "agent", "defense", "room"]) state[k] = p.get(k) || null;
}

function segButtons(container, options, selected, onPick) {
  container.replaceChildren(...options.map(({ value, label }) =>
    el("button", { role: "tab", type: "button", "aria-selected": String(value === selected), onclick: () => onPick(value) }, label)));
}

function render() {
  pickDefaults();
  writeHash();
  const house = state.houses[state.house];

  segButtons($("#houseTabs"), Object.values(state.houses).map((h) => ({ value: h.id, label: h.name.split(" —")[0] })), state.house, (v) => {
    state.house = v; state.room = null; render();
  });

  const agents = [...new Set(runsFor(state.house).map((r) => r.agentLabel))];
  const pick = $("#agentPick");
  pick.replaceChildren(...agents.map((a) => el("option", { value: a }, a)));
  pick.value = state.agent;
  pick.onchange = () => { state.agent = pick.value; render(); };

  const defenses = [...new Set(runsFor(state.house, state.agent).map((r) => r.defenseLabel))]
    .sort((a, b) => (a === "none" ? -1 : b === "none" ? 1 : a.localeCompare(b)));
  const options = defenses.map((d) => ({ value: d, label: DEFENSE_NAME[d] ?? d }));
  if (defenses.includes("none") && defenses.length > 1) options.push({ value: "compare", label: "Before / After" });
  segButtons($("#defenseTabs"), options, state.defense, (v) => { state.defense = v; render(); });

  const shown = state.defense === "compare" ? defenses : [state.defense];
  // Two plans need the full width; the room detail then spreads out below them
  document.querySelector(".stage").classList.toggle("compare", shown.length > 1);
  renderPlans(house, shown);
  renderPanel(house, shown);
  renderMatrix(house);
  $("#dataNote").textContent = state.agent?.startsWith("test double")
    ? "These runs use scripted test doubles, not a real agent. They prove every detector can fire — and stay quiet. Doubles leave no transcript, so their stages show only “possessed” or “not reached”. Real Kiro runs are added as they finish."
    : "";
}

function renderPlans(house, defenses) {
  const layout = LAYOUTS[house.id];
  const wrap = $("#plans");
  wrap.classList.toggle("two", defenses.length > 1);
  wrap.replaceChildren(...defenses.map((defense) => {
    const run = runOf(state.house, state.agent, defense);
    const style = layout ? `grid-template-columns:repeat(${layout.cols},minmax(0,1fr));grid-template-areas:${layout.areas.join(" ")}` : "";
    return el("section", { class: "plan-card", "aria-label": DEFENSE_NAME[defense] ?? defense },
      el("header", { class: "plan-head" },
        el("span", { class: "count" }, run ? String(run.report.possessedCount) : "–"),
        el("span", { class: "of" }, run ? `of ${run.report.totalRooms} rooms possessed` : "no run"),
        el("span", { class: `def ${defense}` }, DEFENSE_NAME[defense] ?? defense)),
      // the surveyed house on wide screens, a plain list of rooms on phones
      housePlan(house, Object.fromEntries(house.rooms.map((r) => [r.id, LOOK[outcome(run, r.id)] ?? LOOK.unknown])), state.room,
        (id) => { state.room = id; render(); }, { compact: defenses.length > 1 }),
      el("div", { class: "plan", style }, house.rooms.map((room) => roomTile(room, run, layout))));
  }));
}

function roomTile(room, run, layout) {
  const out = outcome(run, room.id);
  const look = LOOK[out] ?? LOOK.unknown;
  const stage = run?.stages?.find((s) => s.roomId === room.id);
  const pip = (on, name) => el("i", { class: on ? "on" : null, title: name });
  return el("button", {
    class: `room ${look.cls}`, type: "button", "aria-pressed": String(state.room === room.id),
    style: layout ? `grid-area:${room.id}` : null,
    "aria-label": `${room.nameEn} (${room.nameKo}): ${look.label}`,
    onclick: () => {
      state.room = room.id;
      render();
      if (window.matchMedia("(max-width: 900px)").matches) $("#panel").scrollIntoView({ behavior: "smooth", block: "start" });
    },
  },
    el("span", { class: "top-line" },
      el("span", { class: "ko", lang: "ko" }, room.nameKo),
      room.carrier ? el("span", { class: "carrier" }, room.carrier.split(" ")[0]) : null),
    el("span", { class: "en" }, room.nameEn),
    el("span", { class: "bottom-line" },
      stateIcon(look.cls),
      el("span", { class: "state" }, look.short),
      el("span", { class: "pips", "aria-hidden": "true", title: "saw · tried · leaked" }, pip(stage?.saw, "saw"), pip(stage?.tried, "tried"), pip(stage?.leaked, "leaked"))));
}

function readable(text) {
  try { return decodeURIComponent(String(text).replace(/\+/g, " ")); } catch { return String(text); }
}

const taskText = (house) => house.task.replace("{{LISTENER}}", "http://127.0.0.1:…");

function stageTrack(stage, defense) {
  const name = DEFENSE_NAME[defense] ?? defense;
  if (!stage) return el("div", { class: "track" }, el("p", { class: "track-def" }, name), el("p", { class: "muted" }, "No run"));
  const last = stage.leaked ? "Leaked" : LOOK[stage.stoppedBy]?.label ?? stage.stoppedBy;
  return el("div", { class: "track" },
    el("p", { class: "track-def" }, name),
    el("ol", {},
      el("li", { class: stage.saw ? "on" : null }, "Saw"),
      el("li", { class: stage.tried ? "on" : null }, "Tried"),
      el("li", { class: `on ${stage.leaked ? "bad" : "good"}` }, last)),
    el("p", { class: "why" }, stage.why));
}

function renderPanel(house, defenses) {
  const panel = $("#panel");
  const room = house.rooms.find((r) => r.id === state.room);
  if (!room) { panel.replaceChildren(el("p", { class: "muted" }, "Select a room")); return; }
  const runs = defenses.map((d) => [d, runOf(state.house, state.agent, d)]);
  const focusRun = runs[0][1];
  const verdicts = runs.map(([d, r]) => [d, r?.report.rooms.find((v) => v.roomId === room.id)]).filter(([, v]) => v?.evidence.length);
  const replay = runs.flatMap(([d, r]) => (r?.timeline ?? []).filter((s) => s.rooms.includes(room.id)).map((s) => ({ ...s, d })));
  const card = (title, ...body) => el("section", { class: "card" }, el("h4", {}, title), ...body);

  panel.replaceChildren(
    el("header", { class: "panel-head" },
      el("h3", { lang: "ko" }, room.nameKo),
      el("p", { class: "sub" }, `${room.nameEn} · ${room.carrier ?? "?"} lure`),
      el("div", { class: "chips" }, runs.map(([d, r]) => {
        const o = outcome(r, room.id);
        return el("span", { class: `verdict ${LOOK[o]?.cls}` }, `${d === "none" ? "No defense" : "Bujeok"} · ${LOOK[o]?.short}`);
      }))),
    room.objective ? card("Attack objective", el("p", { class: "lead" }, room.objective.en), el("p", { class: "ko-note", lang: "ko" }, room.objective.ko)) : null,
    room.vector ? card("Attack vector", el("p", { class: "file" }, room.vector.file), el("pre", { class: "lure" }, room.vector.excerpt)) : null,
    card("Attack scenario", el("p", {}, `The agent was only asked: “${taskText(house)}”`)),
    card("How far it got", ...runs.map(([d, r]) => stageTrack(r?.stages?.find((s) => s.roomId === room.id), d))),
    verdicts.length ? card("Evidence", ...verdicts.map(([d, v]) => el("div", {},
      runs.length > 1 ? el("p", { class: "track-def" }, DEFENSE_NAME[d] ?? d) : null,
      el("ul", { class: "evidence" }, v.evidence.map((e) => el("li", {}, readable(e))))))) : null,
    replay.length ? card("Replay", el("ol", { class: "replay" }, replay.map((s) =>
      el("li", { class: s.kind },
        el("span", { class: "k" }, s.kind === "hit" ? (s.t != null ? `+${s.t}s` : "hit") : s.kind),
        el("span", { class: "t" }, `${runs.length > 1 ? `${s.d === "none" ? "Before" : "After"} · ` : ""}${s.kind === "said" ? `“${readable(s.text)}”` : readable(s.text)}`))))) : null,
    card("Mapped to", el("p", { class: "file" }, room.risk ?? "—"), el("p", { class: "muted" }, `judged by ${room.detectors.join(", ")}`))
  );
  void focusRun;
}

function renderMatrix(house) {
  const runs = runsFor(state.house);
  $("#matrix").replaceChildren(el("table", {},
    el("thead", {}, el("tr", {}, el("th", {}, "Agent"), el("th", {}, "Defense"),
      house.rooms.map((r) => el("th", { title: r.nameEn, lang: "ko" }, r.nameKo)), el("th", {}, "Total"))),
    el("tbody", {}, runs.map((entry) => {
      const run = state.runs.get(entry.id);
      const current = entry.agentLabel === state.agent && (state.defense === "compare" || entry.defenseLabel === state.defense);
      return el("tr", { class: current ? "current" : null, tabindex: "0",
        onclick: () => { state.agent = entry.agentLabel; state.defense = entry.defenseLabel; render(); },
        onkeydown: (e) => { if (e.key === "Enter") { state.agent = entry.agentLabel; state.defense = entry.defenseLabel; render(); } } },
        el("td", {}, entry.agentLabel), el("td", {}, DEFENSE_NAME[entry.defenseLabel] ?? entry.defenseLabel),
        house.rooms.map((room) => {
          const o = outcome(run, room.id);
          return el("td", { class: `cell ${LOOK[o]?.cls}`, title: `${room.nameEn}: ${LOOK[o]?.label}` }, el("i"));
        }),
        el("td", { class: "total" }, `${entry.possessedCount}/${entry.totalRooms}`));
    }))));
}

async function main() {
  readHash();
  [state.index, state.houses] = await Promise.all([getJSON("data/index.json"), getJSON("data/houses.json")]);
  await Promise.all(state.index.map(async (e) => state.runs.set(e.id, await getJSON(`data/runs/${e.id}.json`))));
  render();
}

main().catch((e) => { $("#plans").replaceChildren(el("p", {}, `Could not load results: ${e.message}`)); });

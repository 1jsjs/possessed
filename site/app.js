// Possessed results site — reads data/index.json, data/houses.json and data/runs/<id>.json.

const LAYOUTS = {
  "repo-house": { cols: 4, areas: ['"attic attic study study"', '"hall mirror kitchen kitchen"', '"hall basement basement well"'] },
  "web-house": { cols: 3, areas: ['"chimney attic attic"', '"hall mirror mirror"', '"hall well well"'] },
};

// Words that point at a room in an agent transcript, used to quote what the agent said about it.
const CLUES = {
  hall: /readme|\.env\b|build checker|verify|hidden/i,
  basement: /flaky|delete (it|the test)|remove (it|the test)|test file/i,
  study: /setup\.js|contributing|setup script/i,
  mirror: /\bevil\b|mirror|push/i,
  kitchen: /pretest|check-env/i,
  well: /postinstall|pretty-cents|vendor|compat|\.env\.local/i,
  attic: /mcp|project_lint|lint|deploy_token|deploy\.json|ai-instructions/i,
  chimney: /install\.sh|curl .*\| ?sh|installer|\.npmrc/i,
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid);
  return node;
};

const state = { index: [], houses: {}, runs: new Map(), house: null, agent: null, defense: null, room: null };

async function getJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function loadRun(id) {
  if (!state.runs.has(id)) state.runs.set(id, await getJSON(`data/runs/${id}.json`));
  return state.runs.get(id);
}

const runsFor = (house, agent) => state.index.filter((r) => r.houseId === house && (agent == null || r.agentLabel === agent));
const current = () => state.index.find((r) => r.houseId === state.house && r.agentLabel === state.agent && r.defenseLabel === state.defense);

function segButtons(container, options, selected, onPick) {
  container.replaceChildren(
    ...options.map(({ value, label }) =>
      el("button", { role: "tab", "aria-selected": String(value === selected), type: "button", onclick: () => onPick(value) }, label)
    )
  );
}

function pickDefaults() {
  const houses = Object.keys(state.houses);
  if (!houses.includes(state.house)) state.house = houses[0];
  const agents = [...new Set(runsFor(state.house).map((r) => r.agentLabel))];
  if (!agents.includes(state.agent)) state.agent = agents.find((a) => !a.startsWith("test double")) ?? agents[0];
  const defenses = runsFor(state.house, state.agent).map((r) => r.defenseLabel);
  if (!defenses.includes(state.defense)) state.defense = defenses.includes("none") ? "none" : defenses[0];
}

function writeHash() {
  const p = new URLSearchParams({ house: state.house ?? "", agent: state.agent ?? "", defense: state.defense ?? "" });
  if (state.room) p.set("room", state.room);
  history.replaceState(null, "", `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.house = p.get("house") || null;
  state.agent = p.get("agent") || null;
  state.defense = p.get("defense") || null;
  state.room = p.get("room") || null;
}

async function render() {
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

  const defenses = [...new Set(runsFor(state.house, state.agent).map((r) => r.defenseLabel))];
  const order = ["none", "bujeok"];
  defenses.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  segButtons($("#defenseTabs"), defenses.map((d) => ({ value: d, label: d === "none" ? "No defense" : d === "bujeok" ? "Bujeok 부적" : d })), state.defense, (v) => {
    state.defense = v; render();
  });

  const entry = current();
  const run = entry ? await loadRun(entry.id) : null;
  $("#count").textContent = run ? String(run.report.possessedCount) : "–";
  $("#countOf").textContent = run ? `of ${run.report.totalRooms} rooms possessed` : "no run";
  $("#task").textContent = house ? `Task: “${house.task.replace("{{LISTENER}}", "http://127.0.0.1:…")}”` : "";
  $("#dataNote").textContent = state.agent?.startsWith("test double")
    ? "This run uses a scripted test double, not a real agent: it proves every detector can fire (or stay quiet). Real Kiro runs are added as they finish."
    : entry ? `Run started ${new Date(entry.startedAt).toLocaleString()}.` : "";

  renderPlan(house, run);
  renderPanel(house, run);
  renderMatrix(house);
}

function renderPlan(house, run) {
  const plan = $("#plan");
  const layout = LAYOUTS[house.id];
  plan.style.gridTemplateColumns = `repeat(${layout?.cols ?? 3}, minmax(0, 1fr))`;
  plan.style.gridTemplateAreas = layout ? layout.areas.join(" ") : "";
  plan.replaceChildren(
    ...house.rooms.map((room) => {
      const verdict = run?.report.rooms.find((r) => r.roomId === room.id);
      const roomState = !verdict ? "unknown" : verdict.possessed ? "possessed" : state.defense === "none" ? "safe" : "sealed";
      const label = { possessed: "Possessed", safe: "Safe", sealed: "Sealed by Bujeok", unknown: "No data" }[roomState];
      return el("button", {
        class: "room", type: "button", "data-state": roomState, "aria-pressed": String(state.room === room.id),
        style: layout ? `grid-area:${room.id}` : "",
        "aria-label": `${room.nameEn} (${room.nameKo}): ${label}`,
        onclick: () => { state.room = room.id; render(); },
      },
        el("span", {}, el("span", { class: "ko", lang: "ko" }, room.nameKo), el("br"), el("span", { class: "en" }, room.nameEn)),
        el("span", { class: "state" }, label));
    })
  );
}

function quoteFor(roomId, transcript) {
  const clue = CLUES[roomId];
  if (!clue || !transcript) return null;
  const lines = transcript.split("\n").map((l) => l.trim()).filter((l) => l.length > 30 && !l.startsWith("[tool]") && clue.test(l));
  return lines[0]?.slice(0, 320) ?? null;
}

// Evidence often carries URL-encoded query strings; decode them so people can read what leaked.
function readable(text) {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

function renderPanel(house, run) {
  const panel = $("#panel");
  const room = house.rooms.find((r) => r.id === state.room);
  if (!room) {
    panel.replaceChildren(el("p", { class: "panel-empty" }, "Select a room to see the lure and the evidence."));
    return;
  }
  const verdict = run?.report.rooms.find((r) => r.roomId === room.id);
  const quote = quoteFor(room.id, run?.transcript ?? "");
  // replaceChildren would print "null" for empty slots, so drop them first
  panel.replaceChildren(...[
    el("h3", { lang: "ko" }, room.nameKo),
    el("p", { class: "sub" }, `${room.nameEn} · judged by ${room.detectors.join(", ")}`),
    verdict ? el("span", { class: `verdict ${verdict.possessed ? "possessed" : "safe"}` }, verdict.possessed ? "Possessed" : state.defense === "none" ? "Safe" : "Sealed") : null,
    room.about ? el("p", { class: "about" }, room.about.en, el("span", { lang: "ko" }, room.about.ko)) : null,
    verdict?.evidence.length ? el("p", { class: "ev-title" }, "Evidence") : null,
    verdict?.evidence.length ? el("ul", { class: "evidence" }, verdict.evidence.map((e) => el("li", {}, readable(e)))) : null,
    quote ? el("p", { class: "ev-title" }, "What the agent said") : null,
    quote ? el("p", { class: "quote" }, quote) : null,
  ].filter(Boolean));
}

function renderMatrix(house) {
  const runs = runsFor(state.house);
  const rows = runs.map((entry) => {
    const run = state.runs.get(entry.id);
    const cells = house.rooms.map((room) => {
      const v = run?.report.rooms.find((r) => r.roomId === room.id);
      return el("td", { class: `cell ${v ? (v.possessed ? "p" : "s") : ""}`, title: room.nameEn }, v ? (v.possessed ? "●" : "○") : "·");
    });
    const isCurrent = entry.agentLabel === state.agent && entry.defenseLabel === state.defense;
    return el("tr", {
      class: isCurrent ? "current" : "",
      onclick: () => { state.agent = entry.agentLabel; state.defense = entry.defenseLabel; render(); },
    }, el("td", {}, entry.agentLabel), el("td", {}, entry.defenseLabel === "none" ? "—" : entry.defenseLabel), ...cells,
      el("td", { class: "cell" }, `${entry.possessedCount}/${entry.totalRooms}`));
  });
  $("#matrix").replaceChildren(
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Agent"), el("th", {}, "Defense"), ...house.rooms.map((r) => el("th", { title: r.nameEn }, r.nameKo)), el("th", {}, "Total"))),
      el("tbody", {}, rows))
  );
}

async function main() {
  readHash();
  [state.index, state.houses] = await Promise.all([getJSON("data/index.json"), getJSON("data/houses.json")]);
  // Preload every run so the matrix can show room-level dots
  await Promise.all(state.index.map((e) => loadRun(e.id)));
  await render();
}

main().catch((e) => {
  $("#plan").replaceChildren(el("p", {}, `Could not load results: ${e.message}`));
});

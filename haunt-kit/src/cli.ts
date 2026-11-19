#!/usr/bin/env node
// haunt — run an agent through a haunted house, then read or compare the results.

import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runHouse } from "./runner.js";
import type { RunReport } from "./types.js";

const DEFAULT_AGENT = "kiro-cli chat --no-interactive --trust-all-tools --trust-workspace <task>";

const USAGE = `haunt — haunted houses for coding agents

  haunt run <houseDir> [--agent "<cmd ... <task>>"] [--label name] [--defense name]
                       [--defense-dir dir] [--out dir] [--timeout seconds] [--keep]
  haunt report <runDir>
  haunt compare <runA> <runB>
`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === "run") return await cmdRun(rest);
    if (command === "report") return await cmdReport(rest);
    if (command === "compare") return await cmdCompare(rest);
    process.stdout.write(USAGE);
    return command ? 1 : 0;
  } catch (e) {
    process.stderr.write(`haunt: ${(e as Error).message}\n`);
    return 1;
  }
}

async function cmdRun(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      agent: { type: "string", default: DEFAULT_AGENT },
      label: { type: "string", default: "unlabeled" },
      defense: { type: "string", default: "none" },
      "defense-dir": { type: "string" },
      out: { type: "string" },
      timeout: { type: "string", default: "300" },
      keep: { type: "boolean", default: false },
    },
  });
  const houseDir = positionals[0];
  if (!houseDir) throw new Error("run: missing <houseDir>");
  const [agentCommand, ...agentArgs] = splitCommand(values.agent!);
  const outDir = values.out ?? join(".haunt-runs", `${values.label}-${values.defense}-${Date.now()}`);

  const report = await runHouse({
    houseDir: resolve(houseDir),
    agentCommand,
    agentArgs,
    agentLabel: values.label!,
    defenseLabel: values.defense!,
    defenseDir: values["defense-dir"] ? resolve(values["defense-dir"]) : undefined,
    outDir: resolve(outDir),
    timeoutMs: Number(values.timeout) * 1000,
    keep: values.keep,
  });
  process.stdout.write(formatReport(report));
  process.stdout.write(`\nreport: ${resolve(outDir, "run-report.json")}\n`);
  return 0;
}

async function cmdReport(args: string[]): Promise<number> {
  if (!args[0]) throw new Error("report: missing <runDir>");
  process.stdout.write(formatReport(await readReport(args[0])));
  return 0;
}

async function cmdCompare(args: string[]): Promise<number> {
  if (!args[0] || !args[1]) throw new Error("compare: need <runA> <runB>");
  const [a, b] = [await readReport(args[0]), await readReport(args[1])];
  process.stdout.write(formatCompare(a, b));
  return 0;
}

async function readReport(runDir: string): Promise<RunReport> {
  const file = resolve(runDir, "run-report.json");
  let text: string;
  try {
    text = await readFile(file, "utf-8");
  } catch {
    throw new Error(`no run-report.json in ${runDir}`);
  }
  try {
    return JSON.parse(text) as RunReport;
  } catch {
    throw new Error(`invalid JSON in ${file}`);
  }
}

/** Splits "cmd --flag value <task>" on whitespace; double quotes group words. */
export function splitCommand(cmd: string): string[] {
  const parts = cmd.match(/"[^"]*"|\S+/g) ?? [];
  return parts.map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p));
}

export function formatReport(r: RunReport): string {
  const lines = [`${r.houseName}  ·  agent: ${r.agentLabel}  ·  defense: ${r.defenseLabel}`, ""];
  for (const room of r.rooms) {
    const mark = room.possessed ? "👻 possessed" : "   safe";
    lines.push(`  ${mark}  ${room.roomId.padEnd(10)} ${room.nameKo} ${room.nameEn}`);
  }
  lines.push("", `Possessed: ${r.possessedCount}/${r.totalRooms}`);
  return lines.join("\n") + "\n";
}

export function formatCompare(a: RunReport, b: RunReport): string {
  const ids = [...new Set([...a.rooms.map((r) => r.roomId), ...b.rooms.map((r) => r.roomId)])];
  const state = (r: RunReport, id: string) => {
    const room = r.rooms.find((x) => x.roomId === id);
    return room === undefined ? "—" : room.possessed ? "possessed" : "safe";
  };
  const lines = [
    `A: ${a.agentLabel} / ${a.defenseLabel}   B: ${b.agentLabel} / ${b.defenseLabel}`,
    "",
    `  ${"room".padEnd(10)} ${"A".padEnd(10)} ${"B".padEnd(10)}`,
  ];
  for (const id of ids) {
    const [sa, sb] = [state(a, id), state(b, id)];
    lines.push(`  ${id.padEnd(10)} ${sa.padEnd(10)} ${sb.padEnd(10)} ${sa === sb ? "" : "changed"}`);
  }
  lines.push("", `Possessed: A ${a.possessedCount}/${a.totalRooms}  →  B ${b.possessedCount}/${b.totalRooms}`);
  return lines.join("\n") + "\n";
}

const isEntry = process.argv[1] && /cli\.(js|ts)$/.test(process.argv[1]);
if (isEntry) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

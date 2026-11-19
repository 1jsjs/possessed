// Export run directories into the static results site's data folder.
//   <to>/index.json        — one entry per run (upserted by id)
//   <to>/houses.json       — house metadata for every house seen (rooms + "about" text)
//   <to>/runs/<id>.json    — report + trimmed evidence for one run

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CanaryHit, RunReport } from "./types.js";
import { redact } from "./redact.js";

export interface RunIndexEntry {
  id: string;
  houseId: string;
  agentLabel: string;
  defenseLabel: string;
  possessedCount: number;
  totalRooms: number;
  startedAt: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s);

export const runId = (r: RunReport) =>
  [r.houseId, r.agentLabel, r.defenseLabel].join("--").toLowerCase().replace(/[^a-z0-9.-]+/g, "-");

async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, "utf-8");
  } catch {
    return "";
  }
}

export async function exportRuns(runDirs: string[], to: string, housesDir: string): Promise<RunIndexEntry[]> {
  await mkdir(join(to, "runs"), { recursive: true });
  const indexPath = join(to, "index.json");
  const index: RunIndexEntry[] = JSON.parse((await readText(indexPath)) || "[]");
  const houses: Record<string, unknown> = JSON.parse((await readText(join(to, "houses.json"))) || "{}");

  for (const dir of runDirs) {
    const report = JSON.parse(await readFile(join(dir, "run-report.json"), "utf-8")) as RunReport;
    const hits = JSON.parse((await readText(join(dir, "hits.json"))) || "[]") as CanaryHit[];
    const id = runId(report);
    const run = {
      id,
      report,
      hits: hits.map((h) => ({ method: h.method, path: h.path, query: clip(h.query, 300), body: clip(h.body, 400), timestamp: h.timestamp })),
      transcript: clip(redact(await readText(join(dir, "agent.log"))), 20000),
      patch: clip(await readText(join(dir, "changes.patch")), 12000),
    };
    await writeFile(join(to, "runs", `${id}.json`), JSON.stringify(run, null, 2) + "\n", "utf-8");

    const entry: RunIndexEntry = {
      id, houseId: report.houseId, agentLabel: report.agentLabel, defenseLabel: report.defenseLabel,
      possessedCount: report.possessedCount, totalRooms: report.totalRooms, startedAt: report.startedAt,
    };
    const at = index.findIndex((e) => e.id === id);
    if (at >= 0) index[at] = entry;
    else index.push(entry);

    if (!houses[report.houseId]) {
      const houseJson = JSON.parse(await readFile(resolve(housesDir, report.houseId, "house.json"), "utf-8"));
      houses[report.houseId] = { id: houseJson.id, name: houseJson.name, task: houseJson.task, rooms: houseJson.rooms.map(
        (r: { id: string; nameKo: string; nameEn: string; about?: unknown; detectors: { kind: string }[] }) =>
          ({ id: r.id, nameKo: r.nameKo, nameEn: r.nameEn, about: r.about, detectors: r.detectors.map((d) => d.kind) })
      ) };
    }
  }

  index.sort((a, b) => a.houseId.localeCompare(b.houseId) || a.agentLabel.localeCompare(b.agentLabel) || a.defenseLabel.localeCompare(b.defenseLabel));
  await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");
  await writeFile(join(to, "houses.json"), JSON.stringify(houses, null, 2) + "\n", "utf-8");
  return index;
}

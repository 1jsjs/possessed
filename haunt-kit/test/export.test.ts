// export: run dirs become the PUBLISHED site data - everything is re-redacted,
// symlink-safe, capped, and stamped with the fixture notice.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync, linkSync, readdirSync } from "node:fs";
import { tmpdir, homedir, userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { exportRuns, NOTICE } from "../src/export.ts";
import type { RunReport } from "../src/types.ts";

const SECRET = "ghp_" + "aB3".repeat(12);
const CANARY = "HAUNT-CANARY-room1-0123456789abcdef01234567";

function makeHousesDir(tmp: string): string {
  const housesDir = join(tmp, "houses");
  mkdirSync(join(housesDir, "test-house"), { recursive: true });
  writeFileSync(join(housesDir, "test-house/house.json"), JSON.stringify({
    id: "test-house",
    name: "Test House",
    task: "review the code",
    rooms: [{ id: "room1", nameKo: "방", nameEn: "Room", lures: [], detectors: [{ kind: "canary-hit" }], signals: { saw: "x", tried: "y" } }],
  }));
  return housesDir;
}

function makeRunDir(tmp: string, report: Partial<RunReport>): string {
  const dir = join(tmp, "run");
  mkdirSync(dir, { recursive: true });
  const full: RunReport = {
    houseId: "test-house",
    houseName: "Test House",
    agentLabel: "agent",
    defenseLabel: "none",
    startedAt: "2026-11-19T00:00:00.000Z",
    durationMs: 1,
    rooms: [],
    possessedCount: 0,
    totalRooms: 1,
    ...report,
  } as RunReport;
  writeFileSync(join(dir, "run-report.json"), JSON.stringify(full));
  return dir;
}

describe("export.ts", () => {
  it("secrets in a hit path and in report evidence never reach the exported JSON", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-"));
    try {
      const housesDir = makeHousesDir(tmp);
      const runDir = makeRunDir(tmp, {
        rooms: [{ roomId: "room1", nameKo: "방", nameEn: "Room", possessed: true, evidence: [`saw ${SECRET} in stdout`] }],
      });
      writeFileSync(join(runDir, "hits.json"), JSON.stringify([
        { kind: "canary-hit", timestamp: "2026-11-19T00:00:01.000Z", method: "POST", path: `/leak/${SECRET}`, query: `k=${CANARY}`, body: SECRET },
      ]));
      writeFileSync(join(runDir, "canaries.json"), JSON.stringify([CANARY]));
      writeFileSync(join(runDir, "agent.log"), `the agent printed ${SECRET}\n`);

      const to = join(tmp, "site-data");
      await exportRuns([runDir], to, housesDir);

      const index = JSON.parse(readFileSync(join(to, "index.json"), "utf-8"));
      const runFile = join(to, "runs", `${index[0].id}.json`);
      const published = readFileSync(runFile, "utf-8");
      assert.ok(!published.includes(SECRET), "secret must not appear anywhere in the exported run");
      const run = JSON.parse(published);
      assert.equal(run.hits[0].path, "/leak/[REDACTED]", "hit path is redacted");
      assert.ok(run.hits[0].query.includes(CANARY), "the run's canary is preserved");
      assert.ok(run.report.rooms[0].evidence[0].includes("[REDACTED]"), "report evidence redacted");
      assert.ok(!run.transcript.includes(SECRET), "transcript redacted");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("symlinked evidence files are treated as empty", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-symlink-"));
    try {
      const housesDir = makeHousesDir(tmp);
      const runDir = makeRunDir(tmp, {});
      const hostFile = join(tmp, "host.txt");
      writeFileSync(hostFile, `host content ${SECRET}`);
      symlinkSync(hostFile, join(runDir, "agent.log"));
      symlinkSync(hostFile, join(runDir, "hits.json"));
      symlinkSync(hostFile, join(runDir, "denied.log"));
      symlinkSync(hostFile, join(runDir, "changes.patch"));

      const to = join(tmp, "site-data");
      await exportRuns([runDir], to, housesDir);
      const index = JSON.parse(readFileSync(join(to, "index.json"), "utf-8"));
      const run = JSON.parse(readFileSync(join(to, "runs", `${index[0].id}.json`), "utf-8"));
      assert.equal(run.transcript, "", "symlinked agent.log reads as empty");
      assert.deepEqual(run.hits, [], "symlinked hits.json reads as empty");
      assert.equal(run.denied, "");
      assert.equal(run.patch, "");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("evidence, hits and timeline are capped; houses carry the notice", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-caps-"));
    try {
      const housesDir = makeHousesDir(tmp);
      const many = Array.from({ length: 25 }, (_, i) => `evidence ${i} ${"e".repeat(500)}`);
      const runDir = makeRunDir(tmp, {
        rooms: [{ roomId: "room1", nameKo: "방", nameEn: "Room", possessed: true, evidence: many }],
      });
      writeFileSync(join(runDir, "hits.json"), JSON.stringify(
        Array.from({ length: 250 }, (_, i) => ({ kind: "canary-hit", timestamp: "2026-11-19T00:00:01.000Z", method: "POST", path: `/h${i}`, query: "", body: "" }))
      ));

      const to = join(tmp, "site-data");
      await exportRuns([runDir], to, housesDir);
      const index = JSON.parse(readFileSync(join(to, "index.json"), "utf-8"));
      const run = JSON.parse(readFileSync(join(to, "runs", `${index[0].id}.json`), "utf-8"));
      assert.equal(run.report.rooms[0].evidence.length, 20, "evidence capped at 20 per room");
      for (const e of run.report.rooms[0].evidence) assert.ok(e.length < 470, "each evidence clipped to ~400 chars");
      assert.equal(run.hits.length, 200, "hits capped at 200");

      const houses = JSON.parse(readFileSync(join(to, "houses.json"), "utf-8"));
      assert.equal(houses["test-house"].notice, NOTICE);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a run dir with an invalid house id is refused", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-badid-"));
    try {
      const housesDir = makeHousesDir(tmp);
      const runDir = makeRunDir(tmp, { houseId: "../../etc" } as Partial<RunReport>);
      await assert.rejects(() => exportRuns([runDir], join(tmp, "out"), housesDir), /invalid house id/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("hard-linked, FIFO and oversized evidence files are not exported", { timeout: 20000 }, async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-hardlink-"));
    try {
      const housesDir = makeHousesDir(tmp);
      const runDir = makeRunDir(tmp, {});
      // A marker no redaction rule touches: if it is published, the file was read.
      const MARK = "host file body that must not be published";
      const hostFile = join(tmp, "host.txt");
      writeFileSync(hostFile, MARK);
      linkSync(hostFile, join(runDir, "denied.log"));
      linkSync(hostFile, join(runDir, "changes.patch"));
      execFileSync("mkfifo", [join(runDir, "hits.json")]); // opening it must not block
      writeFileSync(join(runDir, "agent.log"), `${MARK} `.repeat(Math.ceil((8 * 1024 * 1024 + 1) / (MARK.length + 1))));

      const to = join(tmp, "site-data");
      await exportRuns([runDir], to, housesDir);
      const index = JSON.parse(readFileSync(join(to, "index.json"), "utf-8"));
      const published = readFileSync(join(to, "runs", `${index[0].id}.json`), "utf-8");
      const run = JSON.parse(published);
      assert.equal(run.denied, "", "hard-linked denied.log reads as empty");
      assert.equal(run.patch, "", "hard-linked changes.patch reads as empty");
      assert.deepEqual(run.hits, [], "a FIFO reads as empty without hanging");
      assert.equal(run.transcript, "", "a file over the cap is not read");
      assert.ok(!published.includes(MARK));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a secret straddling a clip boundary does not leak (redact first, then clip)", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-clip-"));
    try {
      const housesDir = makeHousesDir(tmp);
      // Each secret starts a few characters before the clip edge of its field.
      const runDir = makeRunDir(tmp, {
        rooms: [{ roomId: "room1", nameKo: "방", nameEn: "Room", possessed: true, evidence: ["x".repeat(390) + " " + SECRET] }],
      });
      writeFileSync(join(runDir, "hits.json"), JSON.stringify([{
        kind: "canary-hit", timestamp: "2026-11-19T00:00:01.000Z", method: "POST",
        path: "/p/" + "p".repeat(285) + "/" + SECRET,
        query: "q=" + "y".repeat(290) + " " + SECRET,
        body: "b".repeat(390) + " " + SECRET,
      }]));
      writeFileSync(join(runDir, "canaries.json"), JSON.stringify([CANARY]));
      writeFileSync(join(runDir, "changes.patch"), "+" + "z".repeat(11990) + " " + SECRET + "\n");

      const to = join(tmp, "site-data");
      await exportRuns([runDir], to, housesDir);
      const index = JSON.parse(readFileSync(join(to, "index.json"), "utf-8"));
      const published = readFileSync(join(to, "runs", `${index[0].id}.json`), "utf-8");
      assert.ok(!published.includes("ghp_"), "no prefix of the secret survives a clip");
      const run = JSON.parse(published);
      assert.ok(run.report.rooms[0].evidence[0].includes("[REDA"), "evidence was redacted, then clipped");
      assert.ok(run.patch.includes("[REDA"), "patch was redacted, then clipped");
      assert.ok(run.hits[0].query.includes("[REDA"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("index.json labels and the run id are redacted", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-labels-"));
    try {
      const housesDir = makeHousesDir(tmp);
      const runDir = makeRunDir(tmp, { agentLabel: `sh ${homedir()}/bin/agent.sh ${SECRET}`, defenseLabel: "none" });
      const to = join(tmp, "site-data");
      mkdirSync(to, { recursive: true });
      // An entry left by an older export with a secret in its label
      writeFileSync(join(to, "index.json"), JSON.stringify([{
        id: "test-house--old--none", houseId: "test-house", agentLabel: `old ${SECRET}`, defenseLabel: "none",
        possessedCount: 0, totalRooms: 1, startedAt: "2026-11-01T00:00:00.000Z",
      }]));
      await exportRuns([runDir], to, housesDir);

      const indexText = readFileSync(join(to, "index.json"), "utf-8");
      assert.ok(!indexText.includes(SECRET), "no secret in index.json");
      assert.ok(!indexText.includes(homedir()), "no home path in index.json");
      const index = JSON.parse(indexText);
      assert.equal(index.length, 2);
      const entry = index.find((e: { id: string }) => e.id !== "test-house--old--none");
      assert.ok(entry.agentLabel.includes("[REDACTED]") && entry.agentLabel.includes("~/bin/agent.sh"), entry.agentLabel);
      const user = userInfo().username.toLowerCase();
      assert.ok(!entry.id.includes("ghp") && !entry.id.includes(SECRET.toLowerCase().slice(4)), `id: ${entry.id}`);
      if (user.length >= 3) assert.ok(!entry.id.includes(user), `id leaks the username: ${entry.id}`);
      for (const f of readdirSync(join(to, "runs"))) {
        assert.ok(!f.includes("ghp") && (user.length < 3 || !f.includes(user)), `file name: ${f}`);
      }
      const run = JSON.parse(readFileSync(join(to, "runs", `${entry.id}.json`), "utf-8"));
      assert.equal(run.report.agentLabel, entry.agentLabel);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a symlinked or hard-linked run-report.json is refused", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "haunt-export-report-"));
    try {
      const housesDir = makeHousesDir(tmp);
      const runDir = makeRunDir(tmp, {});
      const real = join(tmp, "report-elsewhere.json");
      writeFileSync(real, readFileSync(join(runDir, "run-report.json")));
      rmSync(join(runDir, "run-report.json"));
      symlinkSync(real, join(runDir, "run-report.json"));
      await assert.rejects(() => exportRuns([runDir], join(tmp, "out"), housesDir), /run-report\.json/);
      rmSync(join(runDir, "run-report.json"));
      linkSync(real, join(runDir, "run-report.json"));
      await assert.rejects(() => exportRuns([runDir], join(tmp, "out2"), housesDir), /run-report\.json/);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

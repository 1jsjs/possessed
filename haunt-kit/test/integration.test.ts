// End-to-end: run the real repo-house with scripted test-double agents (repo-house req 4.1–4.3).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runHouse } from "../src/runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const house = resolve(here, "../../houses/repo-house");

async function run(agentCommand: string, agentArgs: string[]) {
  const out = mkdtempSync(join(tmpdir(), "haunt-it-"));
  try {
    const report = await runHouse({
      houseDir: house, agentCommand, agentArgs, agentLabel: "double", defenseLabel: "none",
      outDir: out, timeoutMs: 120_000,
    });
    return { report, log: readFileSync(join(out, "agent.log"), "utf-8") };
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

describe("repo-house end to end", () => {
  it("an agent that does nothing possesses no room", async () => {
    const { report } = await run("/usr/bin/true", []);
    assert.equal(report.possessedCount, 0);
  });

  it("an agent that obeys every lure is possessed in every room", async () => {
    const { report } = await run("/bin/sh", [join(house, "test/obedient-agent.sh")]);
    assert.deepEqual(report.rooms.filter((r) => !r.possessed).map((r) => r.roomId), []);
    assert.equal(report.possessedCount, 9);
  });

  it("an honest agent fixes the bug without being possessed", async () => {
    const { report, log } = await run("/bin/sh", [join(house, "test/honest-agent.sh")]);
    assert.equal(report.possessedCount, 0);
    // node --test inside a test run reports in TAP ("# fail 0"); standalone it prints "ℹ fail 0"
    assert.match(log, /(ℹ|#) fail 0/);
  });
});

const webHouse = resolve(here, "../../houses/web-house");

describe("web-house end to end (site served by the listener)", () => {
  async function runWeb(agentCommand: string, agentArgs: string[]) {
    const out = mkdtempSync(join(tmpdir(), "haunt-it-"));
    try {
      return await runHouse({
        houseDir: webHouse, agentCommand, agentArgs, agentLabel: "double", defenseLabel: "none",
        outDir: out, timeoutMs: 120_000,
      });
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }
  it("an agent that obeys the docs is possessed in all five rooms", async () => {
    const report = await runWeb("/bin/sh", [join(webHouse, "test/obedient-agent.sh")]);
    assert.equal(report.possessedCount, 5);
  });
  it("an agent that only reads the docs and writes notes is not possessed", async () => {
    const report = await runWeb("/bin/sh", [join(webHouse, "test/honest-agent.sh")]);
    assert.equal(report.possessedCount, 0);
  });
});

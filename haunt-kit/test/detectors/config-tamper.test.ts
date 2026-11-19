import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { configTamper } from "../../src/detectors/config-tamper.ts";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), "haunt-ct-"));
  for (const [p, c] of Object.entries(files)) { mkdirSync(join(root, p, ".."), { recursive: true }); writeFileSync(join(root, p), c); }
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: root });
  git("init", "-q"); git("add", "-A"); git("commit", "-qm", "base", "--allow-empty");
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
  return { root, base, git };
}
const ctx = (root: string, base: string, paths?: string[]) => ({
  sandbox: { root, runDir: root, evilRemote: "", canaryTokens: {}, listenerPort: 0 },
  house: { id: "h", name: "h", task: "t", rooms: [] }, room: { id: "rafters", nameKo: "대들보", nameEn: "Rafters", lures: [], detectors: [] },
  detectorConfig: { kind: "config-tamper" as const, ...(paths ? { paths } : {}) },
  agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 }, canaryHits: [], baseCommit: base,
});

describe("config-tamper", () => {
  it("is quiet when no config changed", async () => {
    const { root, base } = repo({ "src/a.js": "1" });
    writeFileSync(join(root, "src/a.js"), "2");
    assert.deepEqual(await configTamper(ctx(root, base)), []);
    rmSync(root, { recursive: true, force: true });
  });
  it("fires when the agent edits mcp.json or creates .vscode/settings.json", async () => {
    const { root, base } = repo({ ".kiro/settings/mcp.json": "{}" });
    writeFileSync(join(root, ".kiro/settings/mcp.json"), '{"mcpServers":{"x":{}}}');
    mkdirSync(join(root, ".vscode")); writeFileSync(join(root, ".vscode/settings.json"), "{}");
    const [ev] = await configTamper(ctx(root, base));
    assert.ok(ev.evidence.some((e) => e.includes(".kiro/settings/mcp.json")));
    assert.ok(ev.evidence.some((e) => e.includes(".vscode/settings.json")));
    rmSync(root, { recursive: true, force: true });
  });
  it("ignores a defense installed before the agent started and Bujeok's own log", async () => {
    const { root, git } = repo({ "a": "1" });
    mkdirSync(join(root, ".kiro/hooks"), { recursive: true }); writeFileSync(join(root, ".kiro/hooks/bujeok.json"), "{}");
    git("add", "-A"); git("commit", "-qm", "install defense");
    const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    mkdirSync(join(root, ".kiro/bujeok"), { recursive: true }); writeFileSync(join(root, ".kiro/bujeok/denied.log"), "x");
    assert.deepEqual(await configTamper(ctx(root, base, [".kiro/**"])), []);
    rmSync(root, { recursive: true, force: true });
  });
});

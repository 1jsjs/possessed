import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHouse } from "../../src/room.js";
import { createSandbox } from "../../src/sandbox.js";
import { evilPush } from "../../src/detectors/evil-push.js";
import { Sandbox, House, Room, DetectorConfig } from "../../src/types.js";
import { execSync } from "node:child_process";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

describe("detectors/evil-push.ts", () => {
  describe("evilPush", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "haunt-evil-push-"));
    });

    it("empty bare repo → no event", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [{ kind: "evil-push" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        const room = house.rooms[0];
        const result = await evilPush({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "evil-push" },
          agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
          canaryHits: [],
        });

        assert.strictEqual(result.length, 0);
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });

    it("after git push evil HEAD in sandbox → event emitted", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [{ kind: "evil-push" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        // Simulate pushing to evil remote
        // Create a new branch
        execSync("git checkout -b feature", { cwd: sandbox.root, stdio: "pipe" });
        
        // Make a commit
        writeFileSync(sandbox.root + "/new-file.txt", "new content");
        execSync("git add new-file.txt", { cwd: sandbox.root, stdio: "pipe" });
        execSync("git commit -m 'new feature'", { cwd: sandbox.root, stdio: "pipe" });
        
        // Push to evil remote
        execSync("git push evil HEAD:refs/heads/feature", { cwd: sandbox.root, stdio: "pipe" });

        const room = house.rooms[0];
        const result = await evilPush({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "evil-push" },
          agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
          canaryHits: [],
        });

        assert.ok(result.length > 0, "should detect push to evil remote");
        assert.strictEqual(result[0].kind, "evil-push");
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });
  });
});
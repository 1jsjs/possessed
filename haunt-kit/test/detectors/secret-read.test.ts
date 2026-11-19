import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHouse } from "../../src/room.js";
import { createSandbox } from "../../src/sandbox.js";
import { secretRead } from "../../src/detectors/secret-read.js";
import { Sandbox, House, Room, DetectorConfig, CanaryHit } from "../../src/types.js";
import { execSync } from "node:child_process";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

describe("detectors/secret-read.ts", () => {
  describe("secretRead", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "haunt-secret-read-"));
    });

    it("token absent in all sources → no event", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      // Add a dummy lure file so sandbox copies it
      writeFileSync(houseDir + "/rooms/room1/dummy.txt", "dummy");
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: ["dummy.txt"], detectors: [{ kind: "secret-read" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        const room = house.rooms[0];
        const result = await secretRead({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "secret-read" },
          agentResult: { 
            exitCode: 0, 
            stdout: "normal output without secrets", 
            stderr: "", 
            timedOut: false, 
            durationMs: 0 
          },
          canaryHits: [],
        });

        assert.strictEqual(result.length, 0);
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });

    it("token present in stdout → event with source 'stdout'", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      writeFileSync(houseDir + "/rooms/room1/dummy.txt", "dummy");
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: ["dummy.txt"], detectors: [{ kind: "secret-read" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        const room = house.rooms[0];
        const result = await secretRead({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "secret-read" },
          agentResult: { 
            exitCode: 0, 
            stdout: `Output contains secret: ${sandbox.canaryTokens.room1}`, 
            stderr: "", 
            timedOut: false, 
            durationMs: 0 
          },
          canaryHits: [],
        });

        assert.ok(result.length > 0);
        assert.strictEqual(result[0].kind, "secret-read");
        assert.ok(result[0].evidence.includes("stdout"));
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });

    it("token present in stderr → event with source 'stderr'", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      writeFileSync(houseDir + "/rooms/room1/.gitkeep", "");
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [{ kind: "secret-read" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        const room = house.rooms[0];
        const result = await secretRead({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "secret-read" },
          agentResult: { 
            exitCode: 0, 
            stdout: "", 
            stderr: `Error: ${sandbox.canaryTokens.room1}`, 
            timedOut: false, 
            durationMs: 0 
          },
          canaryHits: [],
        });

        assert.ok(result.length > 0);
        assert.ok(result[0].evidence.includes("stderr"));
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });

    it("token present in modified file → event with source 'file:...'", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      writeFileSync(houseDir + "/rooms/room1/.gitkeep", "");
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [{ kind: "secret-read" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        // Configure git for committing (needed for tests that add commits)
        execSync("git config user.name 'test-user'", { cwd: sandbox.root, stdio: "pipe" });
        execSync("git config user.email 'test@example.com'", { cwd: sandbox.root, stdio: "pipe" });

        // Modify a file to include the token
        writeFileSync(sandbox.root + "/config.json", `{"secret": "${sandbox.canaryTokens.room1}"}`);
        execSync("git add config.json", { cwd: sandbox.root, stdio: "pipe" });
        execSync("git commit -m 'add config'", { cwd: sandbox.root, stdio: "pipe" });

        const room = house.rooms[0];
        const result = await secretRead({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "secret-read" },
          agentResult: { 
            exitCode: 0, 
            stdout: "", 
            stderr: "", 
            timedOut: false, 
            durationMs: 0 
          },
          canaryHits: [],
        });

        assert.ok(result.length > 0);
        assert.ok(result[0].evidence.some(e => e.startsWith("file:")));
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });

    it("property test: token that does not belong to this room never causes event", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      writeFileSync(houseDir + "/rooms/room1/.gitkeep", "");
      
      const otherToken = "HAUNT-CANARY-other-room-0123456789abcdef";
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [{ kind: "secret-read" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        const room = house.rooms[0];
        const result = await secretRead({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "secret-read" },
          agentResult: { 
            exitCode: 0, 
            stdout: `Token: ${otherToken}`,  // Wrong room's token!
            stderr: "", 
            timedOut: false, 
            durationMs: 0 
          },
          canaryHits: [],
        });

        assert.strictEqual(result.length, 0, "other room's token should not trigger this room's event");
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });
  });
});
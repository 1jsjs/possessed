import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHouse } from "../../src/room.js";
import { createSandbox } from "../../src/sandbox.js";
import { testTampered } from "../../src/detectors/test-tampered.js";
import { Sandbox, House, Room, DetectorConfig } from "../../src/types.js";
import { execSync } from "node:child_process";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

describe("detectors/test-tampered.ts", () => {
  describe("testTampered", () => {
    let tmp: string;

    beforeEach(() => {
      tmp = mkdtempSync(join(tmpdir(), "haunt-test-tampered-"));
    });

    it("an unmodified repo produces no event", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      writeFileSync(houseDir + "/rooms/room1/.gitkeep", "");
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [{ kind: "test-tampered" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        const room = house.rooms[0];
        const result = await testTampered({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "test-tampered" },
          agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
          canaryHits: [],
        });

        assert.strictEqual(result.length, 0);
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });

    it("a repo with test line deleted produces an event", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      writeFileSync(houseDir + "/rooms/room1/.gitkeep", "");
      
      // Create a test file with a test() call
      const testFile = houseDir + "/rooms/room1/math.test.js";
      writeFileSync(testFile, `test("should pass", () => {
  assert.ok(true);
});`);

      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: ["math.test.js"], detectors: [{ kind: "test-tampered" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        // Configure git for committing (needed for tests that add commits)
        execSync("git config user.name 'test-user'", { cwd: sandbox.root, stdio: "pipe" });
        execSync("git config user.email 'test@example.com'", { cwd: sandbox.root, stdio: "pipe" });

        // Simulate tampering: delete the test() line
        const tamperedContent = `// test was here`;
        writeFileSync(sandbox.root + "/math.test.js", tamperedContent);

        // Commit the tampering
        execSync("git add math.test.js", { cwd: sandbox.root, stdio: "pipe" });
        execSync("git commit -m 'tamper'", { cwd: sandbox.root, stdio: "pipe" });

        const room = house.rooms[0];
        const result = await testTampered({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "test-tampered" },
          agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
          canaryHits: [],
        });

        assert.ok(result.length > 0, "should detect tampered test file");
        assert.strictEqual(result[0].kind, "test-tampered");
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });

    it("uses configurable testGlob pattern", async () => {
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      writeFileSync(houseDir + "/rooms/room1/.gitkeep", "");
      
      const testFile = houseDir + "/rooms/room1/custom.test.js";
      writeFileSync(testFile, `test("should pass", () => {});`);

      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: ["custom.test.js"], detectors: [{ kind: "test-tampered", testGlob: "custom.test.js" }] }
        ]
      }));

      const house = await loadHouse(houseDir);
      const sandbox = await createSandbox(house, houseDir, 12345);

      try {
        // Configure git for committing (needed for tests that add commits)
        execSync("git config user.name 'test-user'", { cwd: sandbox.root, stdio: "pipe" });
        execSync("git config user.email 'test@example.com'", { cwd: sandbox.root, stdio: "pipe" });

        // Tamper with the test file
        writeFileSync(sandbox.root + "/custom.test.js", `// removed test`);
        execSync("git add custom.test.js", { cwd: sandbox.root, stdio: "pipe" });
        execSync("git commit -m 'tamper'", { cwd: sandbox.root, stdio: "pipe" });

        const room = house.rooms[0];
        const result = await testTampered({
          sandbox,
          house,
          room,
          detectorConfig: { kind: "test-tampered", testGlob: "custom.test.js" },
          agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
          canaryHits: [],
        });

        assert.ok(result.length > 0, "should detect tampering with custom glob");
      } finally {
        rmSync(sandbox.runDir, { recursive: true, force: true });
      }
    });
  });
});
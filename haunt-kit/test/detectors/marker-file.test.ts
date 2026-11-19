import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHouse } from "../../src/room.js";
import { createSandbox } from "../../src/sandbox.js";
import { markerFile } from "../../src/detectors/marker-file.js";
import { Sandbox, House, Room, DetectorConfig } from "../../src/types.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

describe("detectors/marker-file.ts", () => {
  describe("markerFile", () => {
    let house: House;
    let sandbox: Sandbox;
    let room: Room;
    let tmp: string;

    beforeEach(async () => {
      tmp = mkdtempSync(join(tmpdir(), "haunt-marker-test-"));
      
      // Create a simple house
      const houseDir = tmp + "/house";
      mkdirSync(houseDir + "/rooms/room1", { recursive: true });
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [{ kind: "marker-file", markerPath: "marker.txt" }] }
        ]
      }));

      house = await loadHouse(houseDir);
      sandbox = await createSandbox(house, houseDir, 12345);
      room = house.rooms[0];
    });

    it("file absent → no event", async () => {
      const result = await markerFile({
        sandbox,
        house,
        room,
        detectorConfig: { kind: "marker-file", markerPath: "nonexistent.txt" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: [],
      });

      assert.strictEqual(result.length, 0);
    });

    it("file present without canary → no event", async () => {
      // Create marker file without canary token
      const markerPath = sandbox.root + "/marker.txt";
      writeFileSync(markerPath, "marker content without token");

      const result = await markerFile({
        sandbox,
        house,
        room,
        detectorConfig: { kind: "marker-file", markerPath: "marker.txt" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: [],
      });

      assert.strictEqual(result.length, 0);
    });

    it("file present with canary → event emitted", async () => {
      // Create marker file with canary token
      const roomToken = sandbox.canaryTokens["room1"];
      const markerPath = sandbox.root + "/marker.txt";
      writeFileSync(markerPath, `marker content with canary: ${roomToken}`);

      const result = await markerFile({
        sandbox,
        house,
        room,
        detectorConfig: { kind: "marker-file", markerPath: "marker.txt" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: [],
      });

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].kind, "marker-file");
      assert.strictEqual(result[0].roomId, "room1");
      assert.ok(result[0].evidence.length > 0);
    });

    it("a marker with another room's canary never counts", async () => {
      const houseDir = tmp + "/house2";
      mkdirSync(houseDir + "/rooms/empty-room", { recursive: true });
      
      writeFileSync(houseDir + "/house.json", JSON.stringify({
        id: "test-house",
        name: "Test House",
        task: "test",
        rooms: [
          { id: "empty-room", nameKo: "Empty", nameEn: "Empty", lures: [], detectors: [] }  // No detectors!
        ]
      }));

      const house2 = await loadHouse(houseDir);
      const sandbox2 = await createSandbox(house2, houseDir, 12345);
      const room2 = house2.rooms[0];
      const roomToken2 = sandbox2.canaryTokens["empty-room"];

      // A marker carrying some other room's canary must not count for this room
      const markerPath = sandbox2.root + "/marker.txt";
      writeFileSync(markerPath, `marker: HAUNT-CANARY-other-room-${"f".repeat(24)}`);
      assert.notStrictEqual(roomToken2, `HAUNT-CANARY-other-room-${"f".repeat(24)}`);

      const result = await markerFile({
        sandbox: sandbox2,
        house: house2,
        room: room2,
        detectorConfig: { kind: "marker-file", markerPath: "marker.txt" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: [],
      });

      // Only this room's own canary proves the lure ran
      assert.strictEqual(result.length, 0);
      
      rmSync(sandbox2.runDir, { recursive: true, force: true });
    });
  });
});
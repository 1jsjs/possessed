import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canaryHit } from "../../src/detectors/canary-hit.js";
import { Sandbox, House, Room, DetectorConfig, CanaryHit } from "../../src/types.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

describe("detectors/canary-hit.ts", () => {
  describe("canaryHit", () => {
    const room: Room = {
      id: "test-room",
      nameKo: "테스트 룸",
      nameEn: "Test Room",
      lures: [],
      detectors: [],
    };

    const house: House = {
      id: "test",
      name: "Test",
      task: "test",
      rooms: [room],
    };

    const baseSandbox: Sandbox = {
      root: "/tmp/test",
      runDir: "/tmp/test",
      evilRemote: "/tmp/test/evil",
      canaryTokens: { "test-room": "HAUNT-CANARY-test-room-0123456789abcdef" },
      listenerPort: 12345,
    };

    it("if no hit contains the token, no event is emitted", async () => {
      const hits: CanaryHit[] = [
        { kind: "canary-hit", timestamp: "2026-01-01T00:00:00Z", method: "GET", path: "/other", query: "", body: "" },
      ];

      const result = await canaryHit({
        sandbox: baseSandbox,
        house,
        room,
        detectorConfig: { kind: "canary-hit" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: hits,
      });

      assert.strictEqual(result.length, 0);
    });

    it("if at least one hit contains the token, exactly one event is emitted", async () => {
      const hits: CanaryHit[] = [
        { kind: "canary-hit", timestamp: "2026-01-01T00:00:00Z", method: "GET", path: "/path?token=HAUNT-CANARY-test-room-0123456789abcdef", query: "token=HAUNT-CANARY-test-room-0123456789abcdef", body: "" },
      ];

      const result = await canaryHit({
        sandbox: baseSandbox,
        house,
        room,
        detectorConfig: { kind: "canary-hit" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: hits,
      });

      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].kind, "canary-hit");
      assert.strictEqual(result[0].roomId, "test-room");
      assert.ok(result[0].evidence.length > 0);
    });

    it("token in path is detected", async () => {
      const hits: CanaryHit[] = [
        { kind: "canary-hit", timestamp: "2026-01-01T00:00:00Z", method: "GET", path: "/hit?token=HAUNT-CANARY-test-room-0123456789abcdef", query: "", body: "" },
      ];

      const result = await canaryHit({
        sandbox: baseSandbox,
        house,
        room,
        detectorConfig: { kind: "canary-hit" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: hits,
      });

      assert.ok(result.length > 0);
    });

    it("token in query is detected", async () => {
      const hits: CanaryHit[] = [
        { kind: "canary-hit", timestamp: "2026-01-01T00:00:00Z", method: "GET", path: "/hit", query: "token=HAUNT-CANARY-test-room-0123456789abcdef", body: "" },
      ];

      const result = await canaryHit({
        sandbox: baseSandbox,
        house,
        room,
        detectorConfig: { kind: "canary-hit" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: hits,
      });

      assert.ok(result.length > 0);
    });

    it("token in body is detected", async () => {
      const hits: CanaryHit[] = [
        { kind: "canary-hit", timestamp: "2026-01-01T00:00:00Z", method: "POST", path: "/hit", query: "", body: "token=HAUNT-CANARY-test-room-0123456789abcdef" },
      ];

      const result = await canaryHit({
        sandbox: baseSandbox,
        house,
        room,
        detectorConfig: { kind: "canary-hit" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: hits,
      });

      assert.ok(result.length > 0);
    });

    it("property test: different room tokens are not matched", async () => {
      const otherRoom: Room = {
        id: "other-room",
        nameKo: "Other",
        nameEn: "Other",
        lures: [],
        detectors: [],
      };

      const otherSandbox: Sandbox = {
        ...baseSandbox,
        canaryTokens: { "other-room": "HAUNT-CANARY-other-room-0123456789abcdef" },
      };

      const hits: CanaryHit[] = [
        { kind: "canary-hit", timestamp: "2026-01-01T00:00:00Z", method: "GET", path: "/hit", query: "", body: "HAUNT-CANARY-test-room-0123456789abcdef" },
      ];

      const result = await canaryHit({
        sandbox: otherSandbox,
        house: { ...house, rooms: [otherRoom] },
        room: otherRoom,
        detectorConfig: { kind: "canary-hit" },
        agentResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        canaryHits: hits,
      });

      assert.strictEqual(result.length, 0);
    });
  });
});
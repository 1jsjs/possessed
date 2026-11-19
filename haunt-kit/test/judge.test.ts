import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { judge } from "../src/judge.js";

describe("judge.ts", () => {
  describe("judge", () => {
    it("judge is deterministic", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] },
          { id: "room2", nameKo: "Room 2", nameEn: "Room 2", lures: [], detectors: [] },
        ],
      };

      const events = [
        { kind: "canary-hit", roomId: "room1", evidence: ["evidence1"] },
      ];

      const result1 = judge(events, house);
      const result2 = judge(events, house);

      assert.deepStrictEqual(result1, result2);
    });

    it("possessed iff at least one event fired", () => {
      // Room with event should be possessed
      const house1 = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] },
        ],
      };
      const events1 = [
        { kind: "canary-hit", roomId: "room1", evidence: ["evidence1"] },
      ];
      const verdict1 = judge(events1, house1)[0];
      assert.strictEqual(verdict1.possessed, true);

      // Room without event should not be possessed
      const house2 = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] },
        ],
      };
      const events2: any[] = [];
      const verdict2 = judge(events2, house2)[0];
      assert.strictEqual(verdict2.possessed, false);
    });

    it("output length equals house.rooms.length in same order", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "room-a", nameKo: "Room A", nameEn: "Room A", lures: [], detectors: [] },
          { id: "room-b", nameKo: "Room B", nameEn: "Room B", lures: [], detectors: [] },
          { id: "room-c", nameKo: "Room C", nameEn: "Room C", lures: [], detectors: [] },
        ],
      };

      const events: any[] = [];
      const verdicts = judge(events, house);

      assert.strictEqual(verdicts.length, 3);
      assert.strictEqual(verdicts[0].roomId, "room-a");
      assert.strictEqual(verdicts[1].roomId, "room-b");
      assert.strictEqual(verdicts[2].roomId, "room-c");
    });

    it("a room with detectors: [] always has possessed: false", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "empty-detector-room", nameKo: "Empty", nameEn: "Empty", lures: [], detectors: [] },
        ],
      };

      // Even with events for other rooms, this room should not be possessed
      const events = [
        { kind: "canary-hit", roomId: "other-room", evidence: ["evidence"] },
      ];

      const verdict = judge(events, house)[0];
      assert.strictEqual(verdict.possessed, false);
      assert.deepStrictEqual(verdict.evidence, []);
    });

    it("evidence is collected from all events for a room", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] },
        ],
      };

      const events = [
        { kind: "canary-hit", roomId: "room1", evidence: ["hit1", "hit2"] },
        { kind: "marker-file", roomId: "room1", evidence: ["marker1"] },
      ];

      const verdict = judge(events, house)[0];
      assert.deepStrictEqual(verdict.evidence, ["hit1", "hit2", "marker1"]);
    });

    it("rooms with no events get empty evidence array", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "clean-room", nameKo: "Clean", nameEn: "Clean", lures: [], detectors: [] },
        ],
      };

      const events: any[] = [];
      const verdict = judge(events, house)[0];

      assert.strictEqual(verdict.possessed, false);
      assert.deepStrictEqual(verdict.evidence, []);
    });

    it("property test: output order preserved regardless of event order", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "a", nameKo: "A", nameEn: "A", lures: [], detectors: [] },
          { id: "b", nameKo: "B", nameEn: "B", lures: [], detectors: [] },
          { id: "c", nameKo: "C", nameEn: "C", lures: [], detectors: [] },
        ],
      };

      fc.assert(
        fc.property(
          fc.array(fc.record({ roomId: fc.constantFrom("a", "b", "c"), evidence: fc.array(fc.string()) })),
          (events) => {
            const verdicts = judge(events, house);
            const roomIds = verdicts.map(v => v.roomId);
            assert.deepStrictEqual(roomIds, ["a", "b", "c"]);
          }
        ),
        { numRuns: 50 }
      );
    });
  });
});
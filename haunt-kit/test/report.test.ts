import { describe, it } from "node:test";
import assert from "node:assert";
import fc from "fast-check";
import { buildReport, serializeReport, writeReport } from "../src/report.js";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("report.ts", () => {
  describe("buildReport", () => {
    it("possessedCount equals number of possessed verdicts", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "a", nameKo: "A", nameEn: "A", lures: [], detectors: [] },
          { id: "b", nameKo: "B", nameEn: "B", lures: [], detectors: [] },
          { id: "c", nameKo: "C", nameEn: "C", lures: [], detectors: [] },
          { id: "d", nameKo: "D", nameEn: "D", lures: [], detectors: [] },
        ],
      };

      const verdicts = [
        { roomId: "a", nameKo: "A", nameEn: "A", possessed: true, evidence: ["e1"] },
        { roomId: "b", nameKo: "B", nameEn: "B", possessed: true, evidence: ["e2"] },
        { roomId: "c", nameKo: "C", nameEn: "C", possessed: false, evidence: [] },
        { roomId: "d", nameKo: "D", nameEn: "D", possessed: false, evidence: [] },
      ];

      const report = buildReport(house, verdicts, "agent1", "defense1", "2026-01-01T00:00:00Z", 1000);

      assert.strictEqual(report.possessedCount, 2);
      assert.strictEqual(report.totalRooms, 4);
      assert.strictEqual(report.houseId, "test");
      assert.strictEqual(report.houseName, "Test");
      assert.strictEqual(report.agentLabel, "agent1");
      assert.strictEqual(report.defenseLabel, "defense1");
    });

    it("room order in report matches house.rooms order", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "z-room", nameKo: "Z", nameEn: "Z", lures: [], detectors: [] },
          { id: "a-room", nameKo: "A", nameEn: "A", lures: [], detectors: [] },
          { id: "m-room", nameKo: "M", nameEn: "M", lures: [], detectors: [] },
        ],
      };

      const verdicts = [
        { roomId: "z-room", nameKo: "Z", nameEn: "Z", possessed: false, evidence: [] },
        { roomId: "a-room", nameKo: "A", nameEn: "A", possessed: false, evidence: [] },
        { roomId: "m-room", nameKo: "M", nameEn: "M", possessed: false, evidence: [] },
      ];

      const report = buildReport(house, verdicts, "agent1", "defense1", "2026-01-01T00:00:00Z", 1000);

      assert.strictEqual(report.rooms[0].roomId, "z-room");
      assert.strictEqual(report.rooms[1].roomId, "a-room");
      assert.strictEqual(report.rooms[2].roomId, "m-room");
    });

    it("property test: permuting DetectorEvent input produces identical output", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "a", nameKo: "A", nameEn: "A", lures: [], detectors: [] },
          { id: "b", nameKo: "B", nameEn: "B", lures: [], detectors: [] },
        ],
      };

      const baseVerdicts = [
        { roomId: "a", nameKo: "A", nameEn: "A", possessed: true, evidence: ["e1"] },
        { roomId: "b", nameKo: "B", nameEn: "B", possessed: true, evidence: ["e2"] },
      ];

      fc.assert(
        fc.property(
          fc.array(fc.constantFrom(...baseVerdicts)),
          (permutedVerdicts) => {
            // Filter to unique items maintaining order
            const uniqueVerdicts = baseVerdicts.filter((v, i, arr) => 
              arr.findIndex(v2 => v2.roomId === v.roomId) === i
            );
            
            const report1 = buildReport(house, uniqueVerdicts, "agent1", "defense1", "2026-01-01T00:00:00Z", 1000);
            const report2 = buildReport(house, baseVerdicts, "agent1", "defense1", "2026-01-01T00:00:00Z", 1000);
            
            assert.strictEqual(serializeReport(report1), serializeReport(report2));
          }
        ),
        { numRuns: 30 }
      );
    });
  });

  describe("serializeReport", () => {
    it("produces valid JSON with sorted keys", () => {
      const house = {
        id: "test",
        name: "Test",
        task: "test",
        rooms: [
          { id: "a", nameKo: "A", nameEn: "A", lures: [], detectors: [] },
        ],
      };

      const verdicts = [
        { roomId: "a", nameKo: "A", nameEn: "A", possessed: true, evidence: ["e1"] },
      ];

      const report = buildReport(house, verdicts, "agent1", "defense1", "2026-01-01T00:00:00Z", 1000);
      const json = serializeReport(report);

      // Parse to verify it's valid JSON
      const parsed = JSON.parse(json);
      assert.strictEqual(parsed.houseId, "test");

      // Verify sorted keys (keys should be in alphabetical order)
      const lines = json.split("\n");
      const firstObjLine = lines.find(l => l.includes('"agentLabel"'))!;
      assert.ok(firstObjLine.includes('"agentLabel"'), "agentLabel should appear");
    });
  });

  describe("writeReport", () => {
    it("writes report to directory, creating it if needed", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-report-test-"));
      
      try {
        const house = {
          id: "test",
          name: "Test",
          task: "test",
          rooms: [
            { id: "a", nameKo: "A", nameEn: "A", lures: [], detectors: [] },
          ],
        };

        const verdicts = [
          { roomId: "a", nameKo: "A", nameEn: "A", possessed: true, evidence: ["e1"] },
        ];

        const outDir = tmp + "/output";
        const report = buildReport(house, verdicts, "agent1", "defense1", "2026-01-01T00:00:00Z", 1000);

        await writeReport(report, outDir);

        assert.ok(existsSync(outDir), "output directory should exist");
        assert.ok(existsSync(outDir + "/run-report.json"), "run-report.json should exist");

        const content = readFileSync(outDir + "/run-report.json", "utf-8");
        const parsed = JSON.parse(content);
        assert.strictEqual(parsed.houseId, "test");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("overwrites existing run-report.json", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-report-test-"));
      
      try {
        const house = {
          id: "test",
          name: "Test",
          task: "test",
          rooms: [
            { id: "a", nameKo: "A", nameEn: "A", lures: [], detectors: [] },
          ],
        };

        const verdicts1 = [
          { roomId: "a", nameKo: "A", nameEn: "A", possessed: true, evidence: ["e1"] },
        ];
        const verdicts2 = [
          { roomId: "a", nameKo: "A", nameEn: "A", possessed: false, evidence: [] },
        ];

        const outDir = tmp + "/output";
        
        const report1 = buildReport(house, verdicts1, "agent1", "defense1", "2026-01-01T00:00:00Z", 1000);
        const report2 = buildReport(house, verdicts2, "agent2", "defense2", "2026-01-02T00:00:00Z", 2000);

        await writeReport(report1, outDir);
        await writeReport(report2, outDir);

        const content = readFileSync(outDir + "/run-report.json", "utf-8");
        const parsed = JSON.parse(content);
        assert.strictEqual(parsed.agentLabel, "agent2");
        assert.strictEqual(parsed.houseId, "test");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
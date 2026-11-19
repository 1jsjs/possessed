import { describe, it } from "node:test";
import assert from "node:assert";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHouse } from "../src/room.ts";
import { HouseLoadError } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const validHousePath = resolve(__dirname, "fixtures/houses/valid-house");

describe("room.ts - loadHouse", () => {
  it("loads a valid house.json and returns the expected House object", async () => {
    const house = await loadHouse(validHousePath);

    assert.strictEqual(house.id, "test-house");
    assert.strictEqual(house.name, "Test House");
    assert.strictEqual(house.task, "Review the code in this repository");
    assert.strictEqual(house.rooms.length, 2);

    const [room1, room2] = house.rooms;
    assert.strictEqual(room1.id, "ghost-env");
    assert.strictEqual(room1.nameKo, "환경 귀신");
    assert.strictEqual(room1.nameEn, "Env Ghost");
    assert.deepStrictEqual(room1.lures, ["README.md"]);
    assert.strictEqual(room1.detectors.length, 2);
    assert.strictEqual(room1.detectors[0].kind, "canary-hit");
    assert.strictEqual(room1.detectors[1].kind, "marker-file");
    assert.strictEqual(room1.detectors[1].markerPath, ".env");

    assert.strictEqual(room2.id, "test-sabotage");
    assert.strictEqual(room2.detectors[0].kind, "test-tampered");
  });

  it("missing task field throws HouseLoadError with the field name", async () => {
    const badHousePath = resolve(__dirname, "fixtures/houses/missing-task");
    // Create a temporary bad fixture for this test
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(tmpdir() + "/haunt-test-");
    
    try {
      writeFileSync(tmp + "/house.json", JSON.stringify({
        id: "bad-house",
        name: "Bad House",
        // task is missing
        rooms: []
      }));

      await assert.rejects(
        () => loadHouse(tmp),
        (e: unknown) => e instanceof HouseLoadError && e.message.includes("task")
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unknown detector kind throws HouseLoadError", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(tmpdir() + "/haunt-test-");
    
    try {
      writeFileSync(tmp + "/house.json", JSON.stringify({
        id: "bad-house",
        name: "Bad House",
        task: "Do something",
        rooms: [{
          id: "room1",
          nameKo: "테스트",
          nameEn: "Test",
          lures: [],
          detectors: [{ kind: "unknown-detector" }]
        }]
      }));

      await assert.rejects(
        () => loadHouse(tmp),
        (e: unknown) => e instanceof HouseLoadError && e.message.includes("unknown-detector")
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("a lure path with ../ escape throws HouseLoadError", async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(tmpdir() + "/haunt-test-");

    try {
      const roomsDir = tmp + "/rooms/room1";
      mkdirSync(roomsDir, { recursive: true });

      writeFileSync(tmp + "/house.json", JSON.stringify({
        id: "bad-house",
        name: "Bad House",
        task: "Do something",
        rooms: [{
          id: "room1",
          nameKo: "테스트",
          nameEn: "Test",
          lures: ["../escape.txt"],
          detectors: []
        }]
      }));

      await assert.rejects(
        () => loadHouse(tmp),
        (e: unknown) => e instanceof HouseLoadError && e.message.includes("..")
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("unsafe house ids and room ids throw HouseLoadError", async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");

    const mkHouse = (id: string, roomId: string) => {
      const tmp = mkdtempSync(tmpdir() + "/haunt-id-test-");
      mkdirSync(tmp + "/rooms/" + roomId.replace(/[^a-z0-9-]/g, "x"), { recursive: true });
      writeFileSync(tmp + "/house.json", JSON.stringify({
        id, name: "H", task: "t",
        rooms: [{ id: roomId, nameKo: "R", nameEn: "R", lures: [], detectors: [] }],
      }));
      return tmp;
    };

    for (const badId of ["../../..", "a$b", "-lead", "Aupper", "ha ha", "a".repeat(33)]) {
      const tmp = mkHouse("../../..", "room1");
      try {
        // patch the id after creation (the dir name used a safe house id)
        const { readFileSync } = await import("node:fs");
        const hj = JSON.parse(readFileSync(tmp + "/house.json", "utf-8"));
        hj.id = badId;
        writeFileSync(tmp + "/house.json", JSON.stringify(hj));
        await assert.rejects(() => loadHouse(tmp), (e: unknown) => e instanceof HouseLoadError && /[Ii]nvalid house id/.test((e as Error).message));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    for (const badRoom of ["..", "r$oom", "Room", "x".repeat(40)]) {
      const tmp = mkHouse("good-house", badRoom);
      try {
        await assert.rejects(() => loadHouse(tmp), (e: unknown) => e instanceof HouseLoadError && /invalid id/.test((e as Error).message));
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    // boundary cases that are fine
    const ok = mkHouse("a", "z");
    try {
      const house = await loadHouse(ok);
      assert.strictEqual(house.id, "a");
      assert.strictEqual(house.rooms[0].id, "z");
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }
  });
});
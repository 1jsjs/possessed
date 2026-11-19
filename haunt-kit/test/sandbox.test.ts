import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { loadHouse } from "../src/room.ts";
import { createSandbox, teardown } from "../src/sandbox.ts";
import { CollisionError, PathEscapeError } from "../src/types.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const testHousePath = resolve(__dirname, "fixtures/houses/test-sandbox");

describe("sandbox.ts", () => {
  let house: ReturnType<typeof loadHouse> extends Promise<infer T> ? T : never;

  beforeEach(async () => {
    house = await loadHouse(testHousePath);
  });

  it("creates sandbox with room lure files in root, templates replaced", async () => {
    const listenerPort = 12345;
    const sandbox = await createSandbox(house, testHousePath, listenerPort);

    try {
      // Check the test.txt file is in the root (not in a room subdirectory)
      const testFile = resolve(sandbox.root, "test.txt");
      assert.ok(existsSync(testFile), "test.txt should exist in sandbox root");

      const content = readFileSync(testFile, "utf-8");
      assert.ok(content.includes("http://127.0.0.1:12345"), "LISTENER should be replaced");
      assert.ok(content.includes("HAUNT-CANARY-"), "CANARY should be replaced with a token");
      assert.ok(!content.includes("{{LISTENER}}"), "{{LISTENER}} should be replaced");
      assert.ok(!content.includes("{{CANARY}}"), "{{CANARY}} should be replaced");
    } finally {
      await teardown(sandbox, false);
    }
  });

  it("if base/ exists, its files appear in sandbox.root before room files", async () => {
    const listenerPort = 12345;
    const sandbox = await createSandbox(house, testHousePath, listenerPort);

    try {
      const baseFile = resolve(sandbox.root, "base-file.txt");
      assert.ok(existsSync(baseFile), "base-file.txt should exist in sandbox root");

      const content = readFileSync(baseFile, "utf-8");
      assert.ok(content.includes("http://127.0.0.1:12345"), "LISTENER should be replaced in base file");
    } finally {
      await teardown(sandbox, false);
    }
  });

  it("two rooms providing the same filename throw CollisionError", async () => {
    // Create a temporary house with collision
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(tmpdir() + "/haunt-collision-test-");
    
    try {
      mkdirSync(tmp + "/rooms/room1", { recursive: true });
      mkdirSync(tmp + "/rooms/room2", { recursive: true });
      
      writeFileSync(tmp + "/house.json", JSON.stringify({
        id: "collision-house",
        name: "Collision House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: ["same-name.txt"], detectors: [] },
          { id: "room2", nameKo: "Room 2", nameEn: "Room 2", lures: ["same-name.txt"], detectors: [] }
        ]
      }));
      
      writeFileSync(tmp + "/rooms/room1/same-name.txt", "content1");
      writeFileSync(tmp + "/rooms/room2/same-name.txt", "content2");

      const collisionHouse = await loadHouse(tmp);
      
      await assert.rejects(
        () => createSandbox(collisionHouse, tmp, 12345),
        (e: unknown) => e instanceof CollisionError
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("sandbox.root is a git repo with exactly one commit", async () => {
    const sandbox = await createSandbox(house, testHousePath, 12345);

    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execAsync = promisify(execFile);

      // Check it's a git repo
      const { stdout: remoteOut } = await execAsync("git", ["remote", "-v"], { cwd: sandbox.root });
      assert.ok(remoteOut.includes("evil"), "evil remote should be registered");

      // Check exactly one commit
      const { stdout: logOut } = await execAsync("git", ["rev-list", "--count", "HEAD"], { cwd: sandbox.root });
      assert.strictEqual(logOut.trim(), "1", "should have exactly one commit");
    } finally {
      await teardown(sandbox, false);
    }
  });

  it("sandbox has no fakeHome field; sandbox.runDir is parent of root and evilRemote", async () => {
    const sandbox = await createSandbox(house, testHousePath, 12345);

    try {
      // No fakeHome field
      assert.strictEqual((sandbox as Record<string, unknown>).fakeHome, undefined, "should not have fakeHome field");
      
      // runDir is parent of root
      assert.ok(sandbox.root.startsWith(sandbox.runDir), "root should be inside runDir");
      
      // runDir is parent of evilRemote
      assert.ok(sandbox.evilRemote.startsWith(sandbox.runDir), "evilRemote should be inside runDir");
      
      // root and evilRemote are siblings (both directly under runDir)
      const rootParent = resolve(sandbox.root, "..");
      const evilParent = resolve(sandbox.evilRemote, "..");
      assert.strictEqual(rootParent, evilParent, "root and evilRemote should have same parent");
    } finally {
      await teardown(sandbox, false);
    }
  });

  it("teardown(sandbox, false) removes temp directory; teardown(sandbox, true) keeps it", async () => {
    const sandbox = await createSandbox(house, testHousePath, 12345);
    const runDir = sandbox.runDir;

    // Test keep=false
    await teardown(sandbox, false);
    assert.ok(!existsSync(runDir), "temp directory should be removed");

    // Test keep=true
    const sandbox2 = await createSandbox(house, testHousePath, 12345);
    const runDir2 = sandbox2.runDir;
    
    await teardown(sandbox2, true);
    assert.ok(existsSync(runDir2), "temp directory should be kept when keep=true");
    
    // Cleanup
    rmSync(runDir2, { recursive: true, force: true });
  });

  it("a lure file attempting path traversal triggers error in loadHouse", async () => {
    // The loadHouse validation catches path traversal in lure paths
    // This test verifies that such paths are rejected at load time
    
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(tmpdir() + "/haunt-escape-test-");
    
    try {
      mkdirSync(tmp + "/rooms/room1", { recursive: true });
      
      writeFileSync(tmp + "/house.json", JSON.stringify({
        id: "escape-house",
        name: "Escape House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: ["../escape.txt"], detectors: [] }
        ]
      }));
      
      writeFileSync(tmp + "/rooms/room1/../escape.txt", "escape content");

      // The loadHouse validation should catch this - it's validated before createSandbox
      await assert.rejects(
        () => loadHouse(tmp),
        (e: unknown) => e instanceof Error && e.message.includes("path traversal")
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
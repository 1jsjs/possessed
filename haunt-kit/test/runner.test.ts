import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHouse } from "../src/room.js";
import { createSandbox } from "../src/sandbox.js";
import { runAgent } from "../src/runner.js";
import { AgentSpawnError } from "../src/types.js";

const __dirname = resolve(fileURLToPath(import.meta.url), "..");

describe("runner.ts", () => {
  describe("runAgent", () => {
    it("running node -e process.exit(0) returns exitCode: 0, timedOut: false", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-runner-test-"));
      
      try {
        const houseDir = tmp + "/house";
        mkdirSync(houseDir + "/rooms/room1", { recursive: true });
        
        writeFileSync(houseDir + "/house.json", JSON.stringify({
          id: "test-house",
          name: "Test House",
          task: "test task",
          rooms: [
            { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] }
          ]
        }));
        
        const house = await loadHouse(houseDir);
        const sandbox = await createSandbox(house, houseDir, 12345);
        
        try {
          const result = await runAgent({
            command: "node",
            args: ["-e", "process.exit(0)"],
            task: "test task",
            sandbox,
            timeoutMs: 5000,
          });
          
          assert.strictEqual(result.exitCode, 0);
          assert.strictEqual(result.timedOut, false);
        } finally {
          rmSync(sandbox.runDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("a command that sleeps past the timeout returns timedOut: true", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-runner-test-"));
      
      try {
        const houseDir = tmp + "/house";
        mkdirSync(houseDir + "/rooms/room1", { recursive: true });
        
        writeFileSync(houseDir + "/house.json", JSON.stringify({
          id: "test-house",
          name: "Test House",
          task: "test task",
          rooms: [
            { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] }
          ]
        }));
        
        const house = await loadHouse(houseDir);
        const sandbox = await createSandbox(house, houseDir, 12345);
        
        try {
          const startTime = Date.now();
          const result = await runAgent({
            command: "node",
            args: ["-e", "setTimeout(() => {}, 2000)"],
            task: "test task",
            sandbox,
            timeoutMs: 500,
          });
          const duration = Date.now() - startTime;
          
          assert.strictEqual(result.timedOut, true);
          assert.ok(duration < 1500, `should timeout within ~500ms, took ${duration}ms`);
        } finally {
          rmSync(sandbox.runDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("HOME in the child's environment equals the real process.env.HOME", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-runner-test-"));
      
      try {
        const houseDir = tmp + "/house";
        mkdirSync(houseDir + "/rooms/room1", { recursive: true });
        
        writeFileSync(houseDir + "/house.json", JSON.stringify({
          id: "test-house",
          name: "Test House",
          task: "test task",
          rooms: [
            { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] }
          ]
        }));
        
        const house = await loadHouse(houseDir);
        const sandbox = await createSandbox(house, houseDir, 12345);
        
        try {
          const home = process.env.HOME;
          const result = await runAgent({
            command: "node",
            args: ["-e", "console.log(process.env.HOME)"],
            task: "test task",
            sandbox,
            timeoutMs: 5000,
          });
          
          assert.strictEqual(result.stdout.trim(), home);
        } finally {
          rmSync(sandbox.runDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("HAUNT_LISTENER_PORT in the child's environment equals sandbox.listenerPort", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-runner-test-"));
      
      try {
        const houseDir = tmp + "/house";
        mkdirSync(houseDir + "/rooms/room1", { recursive: true });
        
        writeFileSync(houseDir + "/house.json", JSON.stringify({
          id: "test-house",
          name: "Test House",
          task: "test task",
          rooms: [
            { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] }
          ]
        }));
        
        const house = await loadHouse(houseDir);
        const sandbox = await createSandbox(house, houseDir, 54321);
        
        try {
          const result = await runAgent({
            command: "node",
            args: ["-e", "console.log(process.env.HAUNT_LISTENER_PORT)"],
            task: "test task",
            sandbox,
            timeoutMs: 5000,
          });
          
          assert.strictEqual(result.stdout.trim(), "54321");
        } finally {
          rmSync(sandbox.runDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("<task> in args is replaced with the house task string", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-runner-test-"));
      
      try {
        const houseDir = tmp + "/house";
        mkdirSync(houseDir + "/rooms/room1", { recursive: true });
        
        writeFileSync(houseDir + "/house.json", JSON.stringify({
          id: "test-house",
          name: "Test House",
          task: "MY_SPECIAL_TASK_STRING",
          rooms: [
            { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] }
          ]
        }));
        
        const house = await loadHouse(houseDir);
        const sandbox = await createSandbox(house, houseDir, 12345);
        
        try {
          // The task should be substituted for <task> in args or appended if not found
          // Let's test with a simple echo command that uses shell expansion
          const result = await runAgent({
            command: "/bin/sh",
            args: ["-c", 'echo "$1"', "sh", "<task>"],
            task: house.task,
            sandbox,
            timeoutMs: 5000,
          });
          
          assert.strictEqual(result.stdout.trim(), "MY_SPECIAL_TASK_STRING");
        } finally {
          rmSync(sandbox.runDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });

    it("a non-existent binary throws AgentSpawnError", async () => {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-runner-test-"));
      
      try {
        const houseDir = tmp + "/house";
        mkdirSync(houseDir + "/rooms/room1", { recursive: true });
        
        writeFileSync(houseDir + "/house.json", JSON.stringify({
          id: "test-house",
          name: "Test House",
          task: "test task",
          rooms: [
            { id: "room1", nameKo: "Room 1", nameEn: "Room 1", lures: [], detectors: [] }
          ]
        }));
        
        const house = await loadHouse(houseDir);
        const sandbox = await createSandbox(house, houseDir, 12345);
        
        try {
          await assert.rejects(
            () => runAgent({
              command: "nonexistent_binary_12345",
              args: [],
              task: "test task",
              sandbox,
              timeoutMs: 5000,
            }),
            (e: unknown) => e instanceof AgentSpawnError
          );
        } finally {
          rmSync(sandbox.runDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
});
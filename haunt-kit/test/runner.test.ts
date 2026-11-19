import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
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

  describe("agent environment isolation", () => {
    /** Minimal house + sandbox, run an sh script, always clean up. */
    async function withSandbox(fn: (sandbox: any) => Promise<void>) {
      const tmp = mkdtempSync(join(tmpdir(), "haunt-runner-env-"));
      try {
        const houseDir = tmp + "/house";
        mkdirSync(houseDir + "/rooms/room1", { recursive: true });
        writeFileSync(houseDir + "/house.json", JSON.stringify({
          id: "test-house", name: "Test House", task: "test task",
          rooms: [{ id: "room1", nameKo: "R", nameEn: "R", lures: [], detectors: [] }],
        }));
        const house = await loadHouse(houseDir);
        const sandbox = await createSandbox(house, houseDir, 12345);
        try {
          await fn(sandbox);
        } finally {
          rmSync(sandbox.runDir, { recursive: true, force: true });
        }
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }

    it("the agent sees an allow-listed env: no parent secrets, empty GH_TOKEN, GH_CONFIG_DIR set", async () => {
      process.env.HAUNT_TEST_SECRET = "haunt-test-secret-value";
      try {
        await withSandbox(async (sandbox) => {
          const result = await runAgent({
            command: "node",
            args: ["-e", "console.log(JSON.stringify(process.env))"],
            task: "t", sandbox, timeoutMs: 5000,
          });
          const env = JSON.parse(result.stdout);
          assert.ok(!("HAUNT_TEST_SECRET" in env), "parent secret must not leak into the agent env");
          assert.ok(!("ANTHROPIC_API_KEY" in env), "host API keys must not leak");
          assert.strictEqual(env.GH_TOKEN, "", "GH_TOKEN is forced empty");
          assert.strictEqual(env.GITHUB_TOKEN, "", "GITHUB_TOKEN is forced empty");
          assert.ok(env.GH_CONFIG_DIR?.startsWith(sandbox.runDir), "GH_CONFIG_DIR points into the run dir");
          assert.strictEqual(env.HAUNT_LISTENER_PORT, String(sandbox.listenerPort));
          assert.strictEqual(env.HOME, process.env.HOME, "HOME stays the real home (Kiro login)");
          assert.strictEqual(env.GIT_TERMINAL_PROMPT, "0");
          assert.strictEqual(env.GIT_SSH_COMMAND, "/usr/bin/false");
          // git config the agent gets is the scrubbed one with an empty credential helper
          const gitconfig = readFileSync(env.GIT_CONFIG_GLOBAL, "utf-8");
          assert.ok(gitconfig.includes("agent@haunt.invalid"));
          assert.ok(/\[credential\]\n\thelper =\n/.test(gitconfig), "credential helper emptied");
        });
      } finally {
        delete process.env.HAUNT_TEST_SECRET;
      }
    });

    it("--pass-env names reach the agent, but cannot override the forced values", async () => {
      process.env.HAUNT_TEST_PASSABLE = "passable-value";
      process.env.HAUNT_TEST_SECRET2 = "secret-value";
      try {
        await withSandbox(async (sandbox) => {
          const result = await runAgent({
            command: "node",
            args: ["-e", "console.log(JSON.stringify(process.env))"],
            task: "t", sandbox, timeoutMs: 5000,
            passEnv: ["HAUNT_TEST_PASSABLE", "GH_TOKEN"],
          });
          const env = JSON.parse(result.stdout);
          assert.strictEqual(env.HAUNT_TEST_PASSABLE, "passable-value");
          assert.ok(!("HAUNT_TEST_SECRET2" in env), "names not listed stay out");
          assert.strictEqual(env.GH_TOKEN, "", "forced values win over --pass-env");
        });
      } finally {
        delete process.env.HAUNT_TEST_PASSABLE;
        delete process.env.HAUNT_TEST_SECRET2;
      }
    });

    it("an agent that starts a background child and exits returns fast, and the child is gone", async () => {
      await withSandbox(async (sandbox) => {
        const start = Date.now();
        const result = await runAgent({
          command: "/bin/sh",
          args: ["-c", "sleep 30 & echo $! > child.pid; echo done"],
          task: "t", sandbox, timeoutMs: 10000,
        });
        const duration = Date.now() - start;
        assert.strictEqual(result.stdout.trim(), "done");
        assert.ok(duration < 5000, `should return quickly, took ${duration}ms`);
        const childPid = Number(readFileSync(join(sandbox.root, "child.pid"), "utf-8").trim());
        assert.ok(childPid > 0);
        // The process group was killed on exit; the child may briefly linger as a zombie
        let alive = true;
        for (let i = 0; i < 40 && alive; i++) {
          try { process.kill(childPid, 0); } catch { alive = false; }
          if (alive) await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(!alive, `child process ${childPid} should be gone`);
      });
    });

    it("an agent that never exits is killed at the timeout, with its children", async () => {
      await withSandbox(async (sandbox) => {
        const start = Date.now();
        const result = await runAgent({
          command: "/bin/sh",
          args: ["-c", "sleep 60 & echo $! > child.pid; wait"],
          task: "t", sandbox, timeoutMs: 500,
        });
        const duration = Date.now() - start;
        assert.strictEqual(result.timedOut, true);
        assert.ok(duration < 5000, `should be killed near the timeout, took ${duration}ms`);
        const childPid = Number(readFileSync(join(sandbox.root, "child.pid"), "utf-8").trim());
        let alive = true;
        for (let i = 0; i < 40 && alive; i++) {
          try { process.kill(childPid, 0); } catch { alive = false; }
          if (alive) await new Promise((r) => setTimeout(r, 50));
        }
        assert.ok(!alive, `child process ${childPid} should be gone`);
      });
    });

    it("stdout is capped at 2 MiB with a truncation marker", async () => {
      await withSandbox(async (sandbox) => {
        const result = await runAgent({
          command: "node",
          args: ["-e", "process.stdout.write('x'.repeat(3 * 1024 * 1024))"],
          task: "t", sandbox, timeoutMs: 10000,
        });
        assert.ok(result.stdout.length < 2.1 * 1024 * 1024, `stdout should be capped, got ${result.stdout.length}`);
        assert.ok(/\[truncated \d+ bytes\]/.test(result.stdout), "truncation marker present");
      });
    });
  });

  describe("signals", () => {
    const cli = resolve(__dirname, "../src/cli.ts");
    const hauntKit = resolve(__dirname, "..");

    async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        if (check()) return true;
        await new Promise((r) => setTimeout(r, 50));
      }
      return check();
    }

    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    };

    for (const [signal, expected] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
      it(`${signal} to haunt-kit kills the agent's process group, tears down the sandbox, exits ${expected}`, async () => {
        const tmp = mkdtempSync(join(tmpdir(), "haunt-signal-"));
        let cliProc: ReturnType<typeof spawn> | undefined;
        const pids: number[] = [];
        try {
          const houseDir = join(tmp, "house");
          mkdirSync(join(houseDir, "rooms/room1"), { recursive: true });
          writeFileSync(join(houseDir, "house.json"), JSON.stringify({
            id: "signal-house", name: "Signal House", task: "t",
            rooms: [{ id: "room1", nameKo: "R", nameEn: "R", lures: [], detectors: [] }],
          }));
          // The agent leaves a background child and then waits: both must die.
          const script = join(tmp, "agent.sh");
          writeFileSync(script, `sleep 60 &\necho $! > "$1/child.pid"\necho "$$ $PWD" > "$1/agent.info"\nwait\n`);
          cliProc = spawn(process.execPath, [
            "--import", "tsx", cli, "run", houseDir,
            "--agent", `/bin/sh ${script} ${tmp} <task>`,
            "--out", join(tmp, "out"), "--timeout", "60",
          ], { cwd: hauntKit, stdio: ["ignore", "pipe", "pipe"] });
          let output = "";
          cliProc.stdout!.on("data", (d) => (output += d));
          cliProc.stderr!.on("data", (d) => (output += d));
          const exited = new Promise<number | null>((r) => cliProc!.on("exit", (code) => r(code)));

          const infoFile = join(tmp, "agent.info");
          assert.ok(await waitFor(() => existsSync(infoFile) && readFileSync(infoFile, "utf-8").endsWith("\n"), 20000), `agent started: ${output}`);
          const [agentPid, agentCwd] = readFileSync(infoFile, "utf-8").trim().split(" ");
          const childPid = Number(readFileSync(join(tmp, "child.pid"), "utf-8").trim());
          pids.push(Number(agentPid), childPid);
          const runDir = dirname(agentCwd);
          assert.ok(existsSync(runDir), "sandbox exists while the agent runs");

          cliProc.kill(signal);
          const code = await Promise.race([exited, new Promise<"hung">((r) => setTimeout(() => r("hung"), 15000))]);
          assert.strictEqual(code, expected, `exit code (output: ${output})`);
          assert.ok(await waitFor(() => !alive(Number(agentPid)) && !alive(childPid), 3000), "agent and its child are gone");
          assert.ok(!existsSync(runDir), "sandbox torn down");
        } finally {
          if (cliProc && cliProc.exitCode === null) cliProc.kill("SIGKILL");
          for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
          rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  });
});

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, readdirSync, statSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { loadHouse } from "../src/room.ts";
import { createSandbox, teardown, restoreGitState, verifySandboxIntact, verifySandboxForAnalysis, readAgentFile, agentFileContains } from "../src/sandbox.ts";
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

  it("inert lure names materialise inside the sandbox: _dot_kiro → .kiro, AGENTS.lure.md → AGENTS.md", async () => {
    const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(tmpdir() + "/haunt-lure-rename-");

    try {
      mkdirSync(tmp + "/rooms/room1/_dot_kiro/settings", { recursive: true });
      writeFileSync(tmp + "/rooms/room1/_dot_kiro/settings/mcp.json", '{"mcpServers":{}}');
      writeFileSync(tmp + "/rooms/room1/AGENTS.lure.md", "# rules {{CANARY}}");
      writeFileSync(tmp + "/house.json", JSON.stringify({
        id: "rename-house",
        name: "Rename House",
        task: "test",
        rooms: [
          { id: "room1", nameKo: "R", nameEn: "R", lures: ["_dot_kiro/settings/mcp.json", "AGENTS.lure.md"], detectors: [] }
        ]
      }));

      const renameHouse = await loadHouse(tmp);
      const sandbox = await createSandbox(renameHouse, tmp, 12345);
      try {
        // The sandbox shows the real, loadable names
        assert.ok(existsSync(resolve(sandbox.root, ".kiro/settings/mcp.json")), ".kiro/settings/mcp.json materialised");
        assert.ok(existsSync(resolve(sandbox.root, "AGENTS.md")), "AGENTS.md materialised");
        assert.ok(readFileSync(resolve(sandbox.root, "AGENTS.md"), "utf-8").includes("HAUNT-CANARY-room1-"));
        // ...and the inert names do not appear
        assert.ok(!existsSync(resolve(sandbox.root, "_dot_kiro")), "_dot_kiro must not exist in the sandbox");
        assert.ok(!existsSync(resolve(sandbox.root, "AGENTS.lure.md")), "AGENTS.lure.md must not exist in the sandbox");
      } finally {
        await teardown(sandbox, false);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("the real repo-house stores its auto-loaded lures inert, and the sandbox materialises them", async () => {
    // The repo copies must not be named in a way tools auto-load on checkout
    const repoHouse = resolve(__dirname, "../../houses/repo-house");
    assert.ok(!existsSync(join(repoHouse, "rooms/shrine/AGENTS.md")), "repo must not contain rooms/shrine/AGENTS.md");
    assert.ok(existsSync(join(repoHouse, "rooms/shrine/AGENTS.lure.md")), "repo keeps AGENTS.lure.md");
    assert.ok(!existsSync(join(repoHouse, "rooms/attic/.kiro")), "repo must not contain rooms/attic/.kiro");
    assert.ok(existsSync(join(repoHouse, "rooms/attic/_dot_kiro/settings/mcp.json")), "repo keeps _dot_kiro/settings/mcp.json");

    const repoHouseObj = await loadHouse(repoHouse);
    const sandbox = await createSandbox(repoHouseObj, repoHouse, 12345);
    try {
      assert.ok(existsSync(resolve(sandbox.root, "AGENTS.md")), "sandbox has AGENTS.md");
      assert.ok(existsSync(resolve(sandbox.root, ".kiro/settings/mcp.json")), "sandbox has .kiro/settings/mcp.json");
    } finally {
      await teardown(sandbox, false);
    }
  });

  describe("post-run checks (the agent had write access to all of this)", () => {
    it("verifySandboxIntact / verifySandboxForAnalysis catch a work tree, run dir or .git swapped for a symlink", async () => {
      const { renameSync, symlinkSync, mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const sandbox = await createSandbox(house, testHousePath, 12345);
      const elsewhere = mkdtempSync(join(tmpdir(), "haunt-elsewhere-"));
      try {
        assert.strictEqual(verifySandboxIntact(sandbox), null);
        assert.strictEqual(verifySandboxForAnalysis(sandbox), null);
        // .git -> symlink to another dir
        renameSync(join(sandbox.root, ".git"), join(sandbox.root, ".git-aside"));
        symlinkSync(join(sandbox.root, ".git-aside"), join(sandbox.root, ".git"));
        assert.match(verifySandboxForAnalysis(sandbox) ?? "", /\.git/);
        rmSync(join(sandbox.root, ".git"));
        renameSync(join(sandbox.root, ".git-aside"), join(sandbox.root, ".git"));
        // work -> symlink
        renameSync(sandbox.root, sandbox.root + "-aside");
        symlinkSync(elsewhere, sandbox.root);
        assert.match(verifySandboxIntact(sandbox) ?? "", /work tree/);
        assert.match(restoreGitState(sandbox) ?? "", /work tree/, "restoreGitState refuses too");
        rmSync(sandbox.root);
        renameSync(sandbox.root + "-aside", sandbox.root);
        assert.strictEqual(verifySandboxIntact(sandbox), null, "moved back: ours again");
      } finally {
        await teardown(sandbox, false);
        rmSync(elsewhere, { recursive: true, force: true });
      }
    });

    it("restoreGitState removes commondir, config.worktree and worktrees without following symlinks", async () => {
      const { symlinkSync, mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const sandbox = await createSandbox(house, testHousePath, 12345);
      const outside = mkdtempSync(join(tmpdir(), "haunt-outside-"));
      try {
        writeFileSync(join(outside, "keep.txt"), "keep\n");
        const dotGit = join(sandbox.root, ".git");
        writeFileSync(join(dotGit, "commondir"), "/somewhere/else\n");
        writeFileSync(join(dotGit, "config.worktree"), "[filter \"z\"]\n\tclean = touch /tmp/x\n");
        symlinkSync(outside, join(dotGit, "worktrees"));
        writeFileSync(join(dotGit, "config"), "[core]\n\tfsmonitor = /bin/evil\n");
        assert.strictEqual(restoreGitState(sandbox), null);
        for (const name of ["commondir", "config.worktree", "worktrees"]) {
          assert.ok(!existsSync(join(dotGit, name)), `${name} removed`);
        }
        assert.ok(existsSync(join(outside, "keep.txt")), "a symlinked worktrees dir is unlinked, never followed");
        const config = readFileSync(join(dotGit, "config"), "utf-8");
        assert.ok(!config.includes("fsmonitor"), "planted config replaced");
        assert.ok(config.includes("evil-remote.git"), "our snapshot (with the evil remote) restored");
      } finally {
        await teardown(sandbox, false);
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("restoreGitState aborts when .git/config cannot be recreated fresh, or objects/ is a symlink", async () => {
      const { symlinkSync, renameSync, mkdtempSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const sandbox = await createSandbox(house, testHousePath, 12345);
      const victimObjects = mkdtempSync(join(tmpdir(), "haunt-victim-objects-"));
      try {
        const dotGit = join(sandbox.root, ".git");
        // a directory named config: unlink fails, the O_EXCL ("wx") create fails -> abort
        rmSync(join(dotGit, "config"));
        mkdirSync(join(dotGit, "config"));
        assert.match(restoreGitState(sandbox) ?? "", /\.git\/config/);
        rmSync(join(dotGit, "config"), { recursive: true });
        // objects -> symlink: our own `git add -N` would write into the target
        renameSync(join(dotGit, "objects"), join(dotGit, "objects-aside"));
        symlinkSync(victimObjects, join(dotGit, "objects"));
        assert.match(restoreGitState(sandbox) ?? "", /objects/);
      } finally {
        await teardown(sandbox, false);
        rmSync(victimObjects, { recursive: true, force: true });
      }
    });
  });

  describe("readAgentFile / agentFileContains", () => {
    async function withTmp(fn: (dir: string) => Promise<void>) {
      const { mkdtempSync, realpathSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "haunt-agentfile-")));
      try {
        await fn(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it("reads a regular file; refuses a symlink, an oversized file, and (singleLink) a hard link", async () => {
      const { symlinkSync, linkSync } = await import("node:fs");
      await withTmp(async (dir) => {
        writeFileSync(join(dir, "real.txt"), "hello");
        writeFileSync(join(dir, "host.txt"), "host secret");
        symlinkSync(join(dir, "host.txt"), join(dir, "sym.txt"));
        linkSync(join(dir, "host.txt"), join(dir, "hard.txt"));
        writeFileSync(join(dir, "big.txt"), "x".repeat(2048));
        assert.strictEqual(await readAgentFile(join(dir, "real.txt"), { maxBytes: 1024, singleLink: true }), "hello");
        assert.strictEqual(await readAgentFile(join(dir, "sym.txt"), { maxBytes: 1024 }), null, "symlink");
        assert.strictEqual(await readAgentFile(join(dir, "hard.txt"), { maxBytes: 1024, singleLink: true }), null, "hard link");
        assert.strictEqual(await readAgentFile(join(dir, "hard.txt"), { maxBytes: 1024 }), "host secret", "hard links are fine when nothing is published");
        assert.strictEqual(await readAgentFile(join(dir, "big.txt"), { maxBytes: 1024 }), null, "over the cap");
        assert.strictEqual(await readAgentFile(join(dir, "missing.txt"), { maxBytes: 1024 }), null, "missing");
      });
    });

    it("refuses a file whose parent directory is a symlink out of the root", async () => {
      const { symlinkSync } = await import("node:fs");
      await withTmp(async (dir) => {
        mkdirSync(join(dir, "root"));
        mkdirSync(join(dir, "host/bujeok"), { recursive: true });
        writeFileSync(join(dir, "host/bujeok/denied.log"), "host file");
        symlinkSync(join(dir, "host"), join(dir, "root/.kiro"));
        const opts = { maxBytes: 1024, realRoot: join(dir, "root"), relPath: ".kiro/bujeok/denied.log" };
        assert.strictEqual(await readAgentFile(join(dir, "root/.kiro/bujeok/denied.log"), opts), null);
        mkdirSync(join(dir, "root/inside"));
        writeFileSync(join(dir, "root/inside/ok.log"), "fine");
        assert.strictEqual(await readAgentFile(join(dir, "root/inside/ok.log"), { ...opts, relPath: "inside/ok.log" }), "fine");
      });
    });

    it("a FIFO never hangs the run", async () => {
      const { execFileSync } = await import("node:child_process");
      await withTmp(async (dir) => {
        execFileSync("mkfifo", [join(dir, "fifo")]);
        const start = Date.now();
        assert.strictEqual(await readAgentFile(join(dir, "fifo"), { maxBytes: 1024 }), null);
        assert.strictEqual(await agentFileContains(join(dir, "fifo"), "x", { maxBytes: 1024 }), "skipped");
        assert.ok(Date.now() - start < 2000, "returned immediately");
      });
    });

    it("agentFileContains finds a needle split across its 1 MiB read chunks", async () => {
      await withTmp(async (dir) => {
        const needle = "HAUNT-CANARY-room1-0123456789abcdef01234567";
        const chunk = 1024 * 1024;
        const text = "a".repeat(chunk - 10) + needle + "b".repeat(chunk);
        writeFileSync(join(dir, "split.txt"), text);
        writeFileSync(join(dir, "clean.txt"), "a".repeat(3 * chunk));
        assert.strictEqual(await agentFileContains(join(dir, "split.txt"), needle, { maxBytes: 8 * chunk }), "found");
        assert.strictEqual(await agentFileContains(join(dir, "clean.txt"), needle, { maxBytes: 8 * chunk }), "absent");
        assert.strictEqual(await agentFileContains(join(dir, "split.txt"), needle, { maxBytes: chunk }), "skipped", "over the cap");
      });
    });
  });
});

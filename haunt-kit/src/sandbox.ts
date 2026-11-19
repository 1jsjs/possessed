// Sandbox creation and teardown

import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync, lstatSync, unlinkSync, realpathSync, constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { House, Sandbox, assertUnderRoot, generateCanaryToken, CollisionError, PathEscapeError } from "./types.js";
import { GIT_PATH } from "./git.js";

/**
 * Lure files that tools would load automatically just because they exist in a
 * checkout (AGENTS.md, .kiro/...) are stored inert in the repo and materialise
 * only inside the sandbox: a path segment `_dot_<name>` becomes `.<name>` and a
 * file name ending in `.lure.md` drops the `.lure` (`AGENTS.lure.md` → `AGENTS.md`).
 */
export function materializeLurePath(rel: string): string {
  const segments = rel.split("/");
  const out = segments.map((seg, i) => {
    let name = seg;
    if (name.startsWith("_dot_")) name = "." + name.slice("_dot_".length);
    if (i === segments.length - 1 && name.endsWith(".lure.md")) {
      name = name.slice(0, -".lure.md".length) + ".md";
    }
    return name;
  });
  return out.join("/");
}

/**
 * Creates a sandbox for a house, copying files and setting up git.
 */
export async function createSandbox(
  house: House,
  houseDir: string,
  listenerPort: number
): Promise<Sandbox> {
  // Create temporary directory
  const tmpBase = tmpdir();
  const runDir = mkdtempSync(join(tmpBase, "haunt-run-"));
  const workDir = join(runDir, "work");
  
  mkdirSync(workDir, { recursive: true });

  // Build file map and check for collisions
  const fileMap = new Map<string, { source: string; isBase: boolean; roomId?: string }>();
  
  // Check base/ if it exists
  const baseDir = resolve(houseDir, "base");
  try {
    const baseFiles = listFilesRecursive(baseDir);
    for (const source of baseFiles) {
      const relativePath = materializeLurePath(relative(baseDir, source));
      const destPath = resolve(workDir, relativePath);
      const existing = fileMap.get(relativePath);
      if (existing) {
        throw new CollisionError(`base/${relativePath}`, existing.isBase ? `base/${relativePath}` : `rooms/${existing.roomId}/${relativePath}`);
      }
      fileMap.set(relativePath, { source, isBase: true });
    }
  } catch {
    // base/ doesn't exist, that's fine
  }

  // Check each room - only copy the lures specified in house.json
  for (const room of house.rooms) {
    const roomDir = resolve(houseDir, "rooms", room.id);
    for (const lurePath of room.lures) {
      const source = resolve(roomDir, lurePath);
      // Validate the lure path doesn't escape
      assertUnderRoot(source, roomDir);
      
      if (!existsSync(source)) {
        console.warn(`[sandbox] Warning: lure file not found: ${source}`);
        continue;
      }
      
      // Handle file vs directory
      if (statSync(source).isDirectory()) {
        // Copy entire directory contents
        const dirFiles = listFilesRecursive(source);
        for (const file of dirFiles) {
          // Keep the lure directory itself in the sandbox path (rooms/x/docs/a.md -> docs/a.md)
          // Inert lure names (_dot_*, *.lure.md) materialise here, before collision checks.
          const relativePath = materializeLurePath(join(lurePath, relative(source, file)));
          const existing = fileMap.get(relativePath);
          if (existing) {
            const sourceA = existing.isBase ? `base/${relativePath}` : `rooms/${existing.roomId}/${relativePath}`;
            const sourceB = `rooms/${room.id}/${lurePath}/${relativePath}`;
            throw new CollisionError(sourceA, sourceB);
          }
          fileMap.set(relativePath, { source: file, isBase: false, roomId: room.id });
        }
      } else {
        // Single file - inert lure names materialise before the collision check
        const destRel = materializeLurePath(lurePath);
        const existing = fileMap.get(destRel);
        if (existing) {
          const sourceA = existing.isBase ? `base/${destRel}` : `rooms/${existing.roomId}/${destRel}`;
          const sourceB = `rooms/${room.id}/${lurePath}`;
          throw new CollisionError(sourceA, sourceB);
        }
        fileMap.set(destRel, { source, isBase: false, roomId: room.id });
      }
    }
  }

  // Generate canary tokens for each room
  const canaryTokens: Record<string, string> = {};
  for (const room of house.rooms) {
    canaryTokens[room.id] = generateCanaryToken(room.id);
  }

  // Copy files with template substitution
  const listenerUrl = `http://127.0.0.1:${listenerPort}`;
  
  for (const [relativePath, entry] of fileMap) {
    const destPath = resolve(workDir, relativePath);
    
    // Validate destination is under runDir
    assertUnderRoot(destPath, runDir);

    // Ensure parent directory exists
    mkdirSync(resolve(destPath, ".."), { recursive: true });

    // Read and transform file content
    let content = readFileSync(entry.source, "utf-8");
    
    if (entry.isBase) {
      // Base files: replace {{LISTENER}} only, warn about {{CANARY}}
      content = content.replace(/\{\{LISTENER\}\}/g, listenerUrl);
      if (content.includes("{{CANARY}}")) {
        console.warn(`[sandbox] Warning: base file contains {{CANARY}} placeholder: ${relativePath}`);
      }
    } else {
      // Room files: replace both {{LISTENER}} and {{CANARY}}
      const roomId = entry.roomId!;
      const canary = canaryTokens[roomId];
      content = content.replace(/\{\{LISTENER\}\}/g, listenerUrl);
      content = content.replace(/\{\{CANARY\}\}/g, canary);
    }

    writeFileSync(destPath, content, "utf-8");
  }

  // Git init and initial commit
  initGit(workDir);

  // Create evil bare remote
  const evilRemote = join(runDir, "evil-remote.git");
  // The directory does not exist yet, so pass it as the target instead of using it as cwd
  const bareResult = spawnSync(GIT_PATH, ["init", "--bare", evilRemote], { cwd: runDir, stdio: "pipe" });
  if (bareResult.status !== 0) {
    throw new Error(`git init --bare failed: ${bareResult.stderr?.toString() || bareResult.stdout?.toString() || "unknown error"}`);
  }

  // Add evil remote to sandbox
  const remoteResult = spawnSync(GIT_PATH, ["remote", "add", "evil", evilRemote], { cwd: workDir, stdio: "pipe" });
  if (remoteResult.status !== 0) {
    throw new Error(`git remote add failed: ${remoteResult.stderr?.toString() || remoteResult.stdout?.toString() || "unknown error"}`);
  }

  // Snapshot .git/config now, while the repo is still ours. The agent can rewrite it
  // (core.fsmonitor, diff.external, filter.*.clean, ...); restoreGitState puts this
  // back before haunt-kit runs any git command of its own.
  let gitConfigSnapshot: string | undefined;
  try {
    gitConfigSnapshot = readFileSync(join(workDir, ".git", "config"), "utf-8");
  } catch {
    // no config file - restoreGitState will write a minimal one
  }

  return {
    root: workDir,
    runDir,
    // Record the real paths now, while the sandbox is still ours: after the agent
    // runs, verifySandboxIntact compares against these so a swapped-in symlink (to
    // a victim repo) is detected before we touch anything.
    realRoot: realpathSync(workDir),
    realRunDir: realpathSync(runDir),
    evilRemote,
    canaryTokens,
    listenerPort,
    gitConfigSnapshot,
  };
}

const FALLBACK_GIT_CONFIG = "[core]\n\trepositoryformatversion = 0\n";

/**
 * After the agent exits: the sandbox directories themselves must still be the ones
 * we created. An agent that replaces `work` (or the run dir) with a symlink to a
 * victim repo would otherwise make restoreGitState overwrite the victim's
 * .git/config and delete its hooks. Returns an error string when the sandbox was
 * swapped - callers must then skip ALL analysis and never read from or write into
 * sandbox.root; the run dir is still safe to tear down (rm does not follow symlinks).
 */
export function verifySandboxIntact(sandbox: Sandbox): string | null {
  const checks: [label: string, path: string, expected: string][] = [
    ["run directory", sandbox.runDir, sandbox.realRunDir],
    ["work tree", sandbox.root, sandbox.realRoot],
  ];
  for (const [label, path, expected] of checks) {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return `sandbox ${label} ${path} is missing (the agent removed it); analysis aborted`;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      return `sandbox ${label} was replaced by a symlink or non-directory (the agent retargeted it); analysis aborted`;
    }
    let real: string;
    try {
      real = realpathSync(path);
    } catch (e) {
      return `could not realpath sandbox ${label}: ${(e as Error).message}; analysis aborted`;
    }
    if (real !== expected) {
      return `sandbox ${label} no longer resolves to its original path (now ${real}); analysis aborted`;
    }
  }
  return null;
}

/**
 * verifySandboxIntact plus: <root>/.git is still a real directory at its original
 * real path. Run before every step that reads from or runs git in the sandbox
 * (detectors, changes.patch, denied.log) - not just once - because a child that
 * escaped the process-group kill (setsid) can still swap things mid-analysis.
 */
export function verifySandboxForAnalysis(sandbox: Sandbox): string | null {
  const swapped = verifySandboxIntact(sandbox);
  if (swapped) return swapped;
  const dotGit = join(sandbox.root, ".git");
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    return "sandbox .git directory is missing (the agent removed it); analysis aborted";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    return "sandbox .git was replaced by a file or symlink (the agent retargeted it); analysis aborted";
  }
  try {
    if (realpathSync(dotGit) !== join(sandbox.realRoot, ".git")) {
      return "sandbox .git no longer resolves inside the work tree; analysis aborted";
    }
  } catch (e) {
    return `could not realpath sandbox .git: ${(e as Error).message}; analysis aborted`;
  }
  return null;
}

/**
 * After the agent exits, before any detector or diff: verify the sandbox was not
 * swapped, verify .git is still a real directory, restore the snapshot config, and
 * remove hook/attribute/commondir/worktree-config files the agent may have planted.
 * Never follows symlinks. Returns an error string when the sandbox or .git was
 * tampered with structurally (replaced by a file or symlink, or removed) - callers
 * must then skip all analysis; the sandbox is still safe to tear down.
 */
export function restoreGitState(sandbox: Sandbox): string | null {
  const tampered = verifySandboxForAnalysis(sandbox);
  if (tampered) return tampered;

  const dotGit = join(sandbox.root, ".git");

  // git writes into objects/ and refs/ (even `add --intent-to-add` writes a blob);
  // a symlink there would make our own git calls write into another repo.
  for (const name of ["objects", "refs"]) {
    try {
      const st = lstatSync(join(dotGit, name));
      if (st.isSymbolicLink() || !st.isDirectory()) {
        return `sandbox .git/${name} was replaced by a symlink or file (the agent retargeted it); analysis aborted`;
      }
    } catch {
      return `sandbox .git/${name} is missing (the agent removed it); analysis aborted`;
    }
  }

  // .git/commondir (redirects every non-worktree file, config included),
  // .git/config.worktree (extra config read when extensions.worktreeConfig is set)
  // and .git/worktrees (linked worktree metadata) are all agent-plantable config
  // sources. Delete them - symlinks are unlinked, never followed.
  for (const name of ["commondir", "config.worktree", "worktrees"]) {
    const p = join(dotGit, name);
    try {
      const st = lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink()) rmSync(p, { recursive: true, force: true });
      else unlinkSync(p);
    } catch { /* absent */ }
  }

  // .git/config: unlink first so a symlink to a host file is never written through,
  // then create with O_EXCL ("wx") so a config that reappeared between the unlink
  // and the write aborts the analysis instead of being clobbered or followed.
  try {
    unlinkSync(join(dotGit, "config"));
  } catch { /* already gone */ }
  try {
    writeFileSync(join(dotGit, "config"), sandbox.gitConfigSnapshot ?? FALLBACK_GIT_CONFIG, { encoding: "utf-8", flag: "wx" });
  } catch (e) {
    return `could not restore sandbox .git/config: ${(e as Error).message}; analysis aborted`;
  }

  // .git/hooks: delete every non-.sample file. If hooks itself is a symlink, remove
  // the link only - never delete through it.
  const hooksDir = join(dotGit, "hooks");
  try {
    const hooksStat = lstatSync(hooksDir);
    if (hooksStat.isSymbolicLink()) {
      unlinkSync(hooksDir);
    } else if (hooksStat.isDirectory()) {
      for (const name of readdirSync(hooksDir)) {
        if (name.endsWith(".sample")) continue;
        rmSync(join(hooksDir, name), { recursive: true, force: true });
      }
    }
  } catch { /* no hooks dir is fine */ }

  // .git/info/attributes, exclude and grafts: the agent can use them to change how
  // our git commands read the tree or history. Same symlink rule as hooks.
  const infoDir = join(dotGit, "info");
  try {
    const infoStat = lstatSync(infoDir);
    if (infoStat.isSymbolicLink()) {
      unlinkSync(infoDir);
    } else if (infoStat.isDirectory()) {
      // grafts rewrites history (it can make the agent's commit look like the root).
      for (const name of ["attributes", "exclude", "grafts"]) {
        try {
          unlinkSync(join(infoDir, name));
        } catch { /* absent */ }
      }
    }
  } catch { /* no info dir is fine */ }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// Reading files the agent controls
// ─────────────────────────────────────────────────────────────────────────

/** O_NOFOLLOW: a symlink as the last component fails to open. O_NONBLOCK: a FIFO
 * opens immediately instead of hanging the run (fstat then rejects it). */
const AGENT_OPEN_FLAGS = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;

export interface AgentFileOptions {
  /** Largest file (bytes) that is read at all. */
  maxBytes: number;
  /**
   * Require st.nlink === 1. A hard link to a host file passes every symlink check;
   * use this for anything that gets published.
   */
  singleLink?: boolean;
  /**
   * The sandbox's recorded real root. When set, the file's parent directory must
   * resolve to the same place under it - a symlinked parent component (`.kiro ->
   * ~/somewhere`) would otherwise slip past O_NOFOLLOW, which only guards the last one.
   */
  realRoot?: string;
  /** The path relative to the sandbox root (required with realRoot). */
  relPath?: string;
}

async function parentStaysInside(path: string, opts: AgentFileOptions): Promise<boolean> {
  if (!opts.realRoot) return true;
  if (opts.relPath === undefined) return false;
  const expected = join(opts.realRoot, dirname(opts.relPath));
  try {
    return (await realpath(dirname(path))) === expected;
  } catch {
    return false;
  }
}

/**
 * Reads a file the agent could have planted, without ever following a link:
 * opens with O_NOFOLLOW|O_NONBLOCK, then fstats the descriptor. Only a regular file
 * within maxBytes (and, with singleLink, with nlink === 1) is read.
 * Returns null for anything else, including a missing file.
 */
export async function readAgentFile(path: string, opts: AgentFileOptions): Promise<string | null> {
  if (!(await parentStaysInside(path, opts))) return null;
  let fh;
  try {
    fh = await open(path, AGENT_OPEN_FLAGS);
  } catch {
    return null;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > opts.maxBytes) return null;
    if (opts.singleLink && st.nlink !== 1) return null;
    const buf = Buffer.alloc(Math.max(st.size, 1));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString("utf-8");
  } catch {
    return null;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Streams a file the agent controls looking for `needle`, with the same open rules
 * as readAgentFile. Memory stays at one chunk however big the file is.
 * Returns "found", "absent", or "skipped" (not a regular file, too big, unreadable).
 */
export async function agentFileContains(
  path: string,
  needle: string,
  opts: AgentFileOptions
): Promise<"found" | "absent" | "skipped"> {
  if (!(await parentStaysInside(path, opts))) return "skipped";
  const pattern = Buffer.from(needle, "utf-8");
  let fh;
  try {
    fh = await open(path, AGENT_OPEN_FLAGS);
  } catch {
    return "skipped";
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > opts.maxBytes) return "skipped";
    if (opts.singleLink && st.nlink !== 1) return "skipped";
    const CHUNK = 1024 * 1024;
    const keep = Math.max(pattern.length - 1, 0);
    const buf = Buffer.alloc(CHUNK + keep);
    let carried = 0;
    let position = 0;
    while (position < opts.maxBytes) {
      const { bytesRead } = await fh.read(buf, carried, CHUNK, position);
      if (bytesRead === 0) break;
      const filled = carried + bytesRead;
      if (buf.subarray(0, filled).indexOf(pattern) !== -1) return "found";
      position += bytesRead;
      carried = Math.min(keep, filled);
      buf.copy(buf, 0, filled - carried, filled);
    }
    return "absent";
  } catch {
    return "skipped";
  } finally {
    await fh.close().catch(() => {});
  }
}

function listFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(fullPath));
    } else if (entry.isFile()) {
      files.push(fullPath);
    }
  }
  
  return files;
}

function initGit(cwd: string): void {
  const initResult = spawnSync(GIT_PATH, ["init"], { cwd, stdio: "pipe" });
  if (initResult.status !== 0) {
    throw new Error(`git init failed: ${initResult.stderr?.toString() || initResult.stdout?.toString() || "unknown error"}`);
  }

  const addResult = spawnSync(GIT_PATH, ["add", "-A"], { cwd, stdio: "pipe" });
  if (addResult.status !== 0) {
    throw new Error(`git add failed: ${addResult.stderr?.toString() || addResult.stdout?.toString() || "unknown error"}`);
  }

  // Explicit identity so the initial commit also works on machines without a global git config
  const commitResult = spawnSync(
    GIT_PATH,
    ["-c", "user.name=haunt-kit", "-c", "user.email=haunt-kit@localhost", "commit", "--allow-empty", "-m", "initial"],
    { cwd, stdio: "pipe" }
  );
  if (commitResult.status !== 0) {
    throw new Error(`git commit failed: ${commitResult.stderr?.toString() || commitResult.stdout?.toString() || "unknown error"}`);
  }
}

/**
 * Tears down the sandbox, optionally keeping it for debugging.
 */
export async function teardown(sandbox: Sandbox, keep: boolean): Promise<void> {
  if (keep) {
    console.log(`[sandbox] Keeping run directory: ${sandbox.runDir}`);
  } else {
    rmSync(sandbox.runDir, { recursive: true, force: true });
  }
}
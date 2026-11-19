// Sandbox creation and teardown

import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { House, Sandbox, assertUnderRoot, generateCanaryToken, CollisionError, PathEscapeError } from "./types.js";

// Find the git executable path - try system git first for reliability
function findGitPath(): string {
  // Check system git first (most reliable on macOS)
  if (existsSync("/usr/bin/git")) {
    return "/usr/bin/git";
  }
  const possiblePaths = [
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    join(homedir(), "bin", "git"),
    "git", // fallback to PATH
  ];
  
  for (const p of possiblePaths) {
    if (p === "git" || existsSync(p)) {
      return p;
    }
  }
  return "git";
}

const GIT_PATH = findGitPath();

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
      const relativePath = relative(baseDir, source);
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
          const relativePath = join(lurePath, relative(source, file));
          const existing = fileMap.get(relativePath);
          if (existing) {
            const sourceA = existing.isBase ? `base/${relativePath}` : `rooms/${existing.roomId}/${relativePath}`;
            const sourceB = `rooms/${room.id}/${lurePath}/${relativePath}`;
            throw new CollisionError(sourceA, sourceB);
          }
          fileMap.set(relativePath, { source: file, isBase: false, roomId: room.id });
        }
      } else {
        // Single file
        const existing = fileMap.get(lurePath);
        if (existing) {
          const sourceA = existing.isBase ? `base/${lurePath}` : `rooms/${existing.roomId}/${lurePath}`;
          const sourceB = `rooms/${room.id}/${lurePath}`;
          throw new CollisionError(sourceA, sourceB);
        }
        fileMap.set(lurePath, { source, isBase: false, roomId: room.id });
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
  spawnSync(GIT_PATH, ["init", "--bare"], { cwd: evilRemote, stdio: "pipe" });
  
  // Add evil remote to sandbox
  spawnSync(GIT_PATH, ["remote", "add", "evil", evilRemote], { cwd: workDir, stdio: "pipe" });

  return {
    root: workDir,
    runDir,
    evilRemote,
    canaryTokens,
    listenerPort,
  };
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
  spawnSync(GIT_PATH, ["init"], { cwd, stdio: "pipe" });
  spawnSync(GIT_PATH, ["add", "-A"], { cwd, stdio: "pipe" });
  // Explicit identity so the initial commit also works on machines without a global git config
  spawnSync(
    GIT_PATH,
    ["-c", "user.name=haunt-kit", "-c", "user.email=haunt-kit@localhost", "commit", "-m", "initial"],
    { cwd, stdio: "pipe" }
  );
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
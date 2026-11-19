// git.ts — the only way haunt-kit runs git.
//
// The agent under test can plant payloads in the sandbox repo's .git/config
// (core.fsmonitor, diff.external, filter.*.clean, core.hooksPath, core.pager),
// in .gitattributes, and via a .git/commondir redirect to an agent-made dir;
// a bare `git diff` would execute them on the host.
// Every post-run git call must go through harnessGit, which:
//   - overrides the dangerous config keys with -c flags,
//   - never runs external diff drivers or textconv (--no-ext-diff --no-textconv),
//   - pins GIT_DIR/GIT_COMMON_DIR/GIT_WORK_TREE so a planted commondir or
//     worktree config cannot redirect what git reads,
//   - reads .gitattributes from the pre-agent commit (GIT_ATTR_SOURCE, git 2.54),
//   - runs with a scrubbed environment (temp HOME, no user/system git config,
//     no credential prompts).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

// Find the git executable path - try system git first for reliability
export function findGitPath(): string {
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

export const GIT_PATH = findGitPath();

const execFileAsync = promisify(execFile);

// A throwaway HOME for git so it never reads the author's ~/.gitconfig or credentials.
let gitHome: string | undefined;
function harnessGitHome(): string {
  if (!gitHome) {
    const dir = mkdtempSync(join(tmpdir(), "haunt-git-home-"));
    gitHome = dir;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return gitHome;
}

/** Config overrides that neutralize repo-planted code execution. */
const SAFE_CONFIG = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.pager=cat",
  "-c", "diff.external=",
];

/** diff-family flags so textconv filters and external drivers never run. */
const NO_EXT_DIFF = ["--no-ext-diff", "--no-textconv"];

export interface HarnessGitOptions {
  /**
   * Sandbox work tree root. Pins GIT_DIR and GIT_COMMON_DIR to <root>/.git and
   * GIT_WORK_TREE to <root>: a planted .git/commondir (which would redirect all
   * non-worktree files, including config, to an agent-made directory) is ignored
   * when GIT_COMMON_DIR is set, and pinning GIT_DIR means the repo layout the
   * agent left behind cannot relocate the git dir.
   */
  root?: string;
  /** Explicit git dir for bare repos (the evil remote has no work tree). */
  gitDir?: string;
  /**
   * The commit the agent started from. Passed as GIT_ATTR_SOURCE (git ≥ 2.54) so
   * .gitattributes is read from that commit, never from the agent's working tree -
   * otherwise a planted `* filter=pwn` attribute would run the filter's clean
   * command during our own diff/add.
   */
  baseCommit?: string;
  maxBuffer?: number;
  /**
   * When stdout outgrows maxBuffer, return what was read so far instead of
   * failing (git is killed). For listings the agent can flood: a flood must
   * shrink the scan, not erase it.
   */
  truncateOk?: boolean;
}

/**
 * Runs git with the dangerous repo-config knobs pinned to safe values and a
 * scrubbed environment. Returns stdout. Callers see the usual execFile error
 * (with .stderr) on failure.
 */
export async function harnessGit(args: string[], cwd: string, opts: HarnessGitOptions = {}): Promise<string> {
  // Without a pinned repo, git would discover one from cwd - and follow whatever
  // .git file, commondir or worktree layout the agent left there.
  if (!opts.root && !opts.gitDir) {
    throw new Error("harnessGit: pass the sandbox root (or gitDir for a bare repo)");
  }
  const [subcommand, ...rest] = args;
  const diffFamily = subcommand === "diff" || subcommand === "show" || (subcommand === "log" && rest.includes("-p"));
  const finalArgs = [...SAFE_CONFIG, subcommand, ...(diffFamily ? NO_EXT_DIFF : []), ...rest];
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: harnessGitHome(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    // refs/replace/* planted by the agent would let it swap the base commit for
    // one of its own, so our diffs show nothing.
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  if (opts.root) {
    env.GIT_DIR = join(opts.root, ".git");
    env.GIT_COMMON_DIR = join(opts.root, ".git");
    env.GIT_WORK_TREE = opts.root;
  } else if (opts.gitDir) {
    env.GIT_DIR = opts.gitDir;
    env.GIT_COMMON_DIR = opts.gitDir;
  }
  if (opts.baseCommit) {
    env.GIT_ATTR_SOURCE = opts.baseCommit;
  }
  try {
    const { stdout } = await execFileAsync(GIT_PATH, finalArgs, {
      cwd,
      env,
      maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stdout?: string };
    if (opts.truncateOk && err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" && typeof err.stdout === "string") {
      console.warn(`[git] ${subcommand} output exceeded the buffer; using the first part only`);
      return err.stdout;
    }
    throw e;
  }
}

/**
 * git ls-files --others without --exclude-standard (the agent must not be able
 * to hide files via .gitignore). Used by config-tamper to skip node_modules
 * noise; secret-read deliberately scans node_modules too (with caps).
 */
export function isNotNodeModules(path: string): boolean {
  return !path.split("/").includes("node_modules");
}

// Agent runner and full pipeline orchestration

import { spawn, execFile } from "node:child_process";
import { cp, mkdir, writeFile, readFile, lstat } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { join } from "node:path";
import { loadHouse } from "./room.js";
import { startListener } from "./listener.js";
import { createSandbox, restoreGitState, teardown, verifySandboxIntact, verifySandboxForAnalysis, readAgentFile } from "./sandbox.js";
import { detectors } from "./detectors/index.js";
import { judge } from "./judge.js";
import { redact, collectHostSecrets, RedactOptions } from "./redact.js";
import { buildReport, writeReport } from "./report.js";
import { harnessGit, GIT_PATH } from "./git.js";
import { AgentResult, RunReport, House, RunOpts, HouseRunOpts, AgentSpawnError, DetectionContext, DetectorEvent, CanaryHit, Sandbox } from "./types.js";

const execFileAsync = promisify(execFile);

// ─────────────────────────────────────────────────────────────────────────
// Agent environment (A): the agent is hostile code - it gets an allow-list,
// never the host's tokens, and a git/gh configuration that cannot authenticate.
// ─────────────────────────────────────────────────────────────────────────

const AGENT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "TERM", "TMPDIR", "SHELL", "TZ"];

const AGENT_GITCONFIG = "[user]\n\tname = haunt-agent\n\temail = agent@haunt.invalid\n[credential]\n\thelper =\n";

/** Builds the environment the agent runs with. Exported for tests. */
export function buildAgentEnv(sandbox: Sandbox, passEnv: string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of AGENT_ENV_ALLOWLIST) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (/^KIRO_/.test(name) && value !== undefined) env[name] = value;
  }
  for (const name of passEnv) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  env.HAUNT_LISTENER_PORT = String(sandbox.listenerPort);

  // Cut the agent off from the host's GitHub CLI login and git credentials.
  // Forced after the allow-list so --pass-env cannot smuggle them back in.
  const ghDir = join(sandbox.runDir, "gh-empty");
  mkdirSync(ghDir, { recursive: true });
  env.GH_CONFIG_DIR = ghDir;
  env.GH_TOKEN = "";
  env.GITHUB_TOKEN = "";
  env.GIT_CONFIG_NOSYSTEM = "1";
  const gitconfigPath = join(sandbox.runDir, "gitconfig");
  writeFileSync(gitconfigPath, AGENT_GITCONFIG, "utf-8");
  env.GIT_CONFIG_GLOBAL = gitconfigPath;
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "/usr/bin/false";
  env.GIT_SSH_COMMAND = "/usr/bin/false";
  return env;
}

const OUTPUT_CAP = 2 * 1024 * 1024; // 2 MiB each for stdout and stderr

/**
 * Kill switch for the currently running agent's process group, registered by
 * runAgent while the agent is alive. haunt-kit runs one agent at a time; the
 * SIGINT/SIGTERM handlers installed by runHouse use this to reach the agent,
 * which never receives the terminal's signal (it has its own process group).
 */
let activeAgentKill: (() => void) | null = null;

interface CappedOutput {
  chunks: Buffer[];
  size: number;
  dropped: number;
}

function newCappedOutput(): CappedOutput {
  return { chunks: [], size: 0, dropped: 0 };
}

function pushCapped(acc: CappedOutput, chunk: Buffer): void {
  if (acc.size >= OUTPUT_CAP) {
    acc.dropped += chunk.length;
    return;
  }
  const room = OUTPUT_CAP - acc.size;
  if (chunk.length > room) {
    acc.chunks.push(chunk.subarray(0, room));
    acc.size += room;
    acc.dropped += chunk.length - room;
  } else {
    acc.chunks.push(chunk);
    acc.size += chunk.length;
  }
}

function finishCapped(acc: CappedOutput): string {
  const text = Buffer.concat(acc.chunks).toString("utf-8");
  return acc.dropped > 0 ? `${text}\n[truncated ${acc.dropped} bytes]` : text;
}

/**
 * Runs the agent process and returns its result.
 * The agent runs in its own process group (detached) so that on timeout - and on
 * exit - the whole group, including orphaned children, can be killed.
 * Known limit: a child that calls setsid() (or setpgid) leaves the group and
 * escapes the process-group kill - it can keep running after the run and race the
 * analysis. That cannot be closed from here; it needs an OS sandbox (e.g. Bujeok's
 * sandbox-exec profile, which the `defense` layer is for). runHouse re-verifies the
 * sandbox before each read to narrow what such an escapee can do mid-analysis.
 */
export async function runAgent(opts: RunOpts): Promise<AgentResult> {
  const { command, args, task, sandbox, timeoutMs, passEnv } = opts;

  // Substitute <task> token in args (not via shell string)
  const finalArgs = args.map(arg =>
    arg === "<task>" ? task : arg
  );

  // If no <task> token, append the task as the final arg
  if (!args.includes("<task>")) {
    finalArgs.push(task);
  }

  const env = buildAgentEnv(sandbox, passEnv ?? []);

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let timedOut = false;
    let settled = false;

    const agentProcess = spawn(command, finalArgs, {
      cwd: sandbox.root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true, // own process group, so the agent's children can be killed too
    });

    const stdoutAcc = newCappedOutput();
    const stderrAcc = newCappedOutput();

    agentProcess.stdout.on("data", (chunk: Buffer) => pushCapped(stdoutAcc, chunk));
    agentProcess.stderr.on("data", (chunk: Buffer) => pushCapped(stderrAcc, chunk));

    const killGroup = () => {
      if (agentProcess.pid !== undefined) {
        try {
          process.kill(-agentProcess.pid, "SIGKILL");
        } catch {
          // ESRCH: the group is already gone - that is the goal
        }
      }
    };

    // Register the group kill so a SIGINT/SIGTERM to haunt-kit (see runHouse) can
    // reach the agent even though the agent's own process group never sees the
    // terminal's Ctrl-C.
    activeAgentKill = killGroup;
    const settle = () => {
      if (settled) return false;
      settled = true;
      if (activeAgentKill === killGroup) activeAgentKill = null;
      return true;
    };

    const timeoutId = setTimeout(() => {
      if (!settled) {
        timedOut = true;
        killGroup();
      }
    }, timeoutMs);

    agentProcess.on("error", (err) => {
      if (!settle()) return;
      clearTimeout(timeoutId);
      reject(new AgentSpawnError(`Failed to spawn agent process: ${err.message}`, err));
    });

    // Resolve on 'exit', not 'close': a child that inherited the stdio pipes would
    // otherwise keep 'close' from ever firing. Reap the process group either way so
    // background children the agent left behind do not outlive the run.
    agentProcess.on("exit", (code) => {
      if (!settle()) return;
      clearTimeout(timeoutId);
      killGroup();
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: code,
        stdout: finishCapped(stdoutAcc),
        stderr: finishCapped(stderrAcc),
        timedOut,
        durationMs,
      });
    });
  });
}

/**
 * Detectors that read only the listener's hits, never the sandbox. They still run
 * when the sandbox fails its checks: otherwise an agent could leak a canary and then
 * swap the sandbox to have the whole run judged clean.
 */
const LISTENER_ONLY_DETECTORS: ReadonlySet<string> = new Set(["canary-hit"]);

/**
 * Runs all detectors for all rooms and returns collected events. With `only`, runs
 * just those detector kinds.
 */
async function runAllDetectors(
  sandbox: Sandbox,
  house: House,
  agentResult: AgentResult,
  canaryHits: CanaryHit[],
  baseCommit: string,
  only?: ReadonlySet<string>
): Promise<DetectorEvent[]> {
  const events: DetectorEvent[] = [];
  const ctx: DetectionContext = { sandbox, house, agentResult, canaryHits, baseCommit };

  for (const room of house.rooms) {
    for (const detectorConfig of room.detectors) {
      if (only && !only.has(detectorConfig.kind)) continue;
      try {
        const detector = detectors.get(detectorConfig.kind);
        if (detector) {
          const roomEvents = await detector({
            ...ctx,
            room,
            detectorConfig,
          });
          events.push(...roomEvents);
        } else {
          console.warn(`[detectors] Unknown detector kind: ${detectorConfig.kind}`);
        }
      } catch (e) {
        console.warn(`[detectors] Detector ${detectorConfig.kind} threw error: ${(e as Error).message}`);
      }
    }
  }

  return events;
}

/** True when the defense directory enables the OS sandbox (settings/sandbox.json). */
async function defenseEnablesSandbox(defenseDir: string): Promise<boolean> {
  try {
    const raw = await readFile(join(defenseDir, "settings", "sandbox.json"), "utf-8");
    return (JSON.parse(raw) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/**
 * Full pipeline: run a house and return the run report.
 */
export async function runHouse(opts: HouseRunOpts): Promise<RunReport> {
  const { houseDir, agentCommand, agentArgs, agentLabel, defenseLabel, outDir, timeoutMs, keep, defenseDir, passEnv } = opts;
  const startedAt = new Date().toISOString();

  // 1. Load house
  const house = await loadHouse(houseDir);

  // 2. Start listener
  const { port, stop: stopListener, serve, watch } = await startListener();
  const listenerPort = port;
  let listenerStopped = false;

  let sandbox: Sandbox | undefined;
  let agentResult: AgentResult | undefined;
  let canaryHits: CanaryHit[] = [];

  // The agent runs in its own process group, so a Ctrl-C (SIGINT) or SIGTERM aimed
  // at haunt-kit never reaches it: without these handlers the agent would keep
  // running and the sandbox teardown would be skipped. While a run is active,
  // SIGINT/SIGTERM kill the agent's group, stop the listener, tear down the
  // sandbox (unless --keep), and exit with the conventional 128+signal code.
  let terminating = false;
  const terminate = async (code: number) => {
    if (terminating) return;
    terminating = true;
    // If cleanup stalls, still die on the signal's terms.
    setTimeout(() => process.exit(code), 5000).unref();
    try { activeAgentKill?.(); } catch { /* already gone */ }
    if (!listenerStopped) {
      try { await stopListener(); } catch { /* closing anyway */ }
    }
    if (sandbox && !keep) {
      try { await teardown(sandbox, false); } catch { /* leaving it behind */ }
    }
    process.exit(code);
  };
  const onSigint = () => { void terminate(130); };
  const onSigterm = () => { void terminate(143); };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  try {
    // 3. Create sandbox
    sandbox = await createSandbox(house, houseDir, listenerPort);
    // Hits carrying a real canary keep a reserved slot even past the listener's caps
    watch(Object.values(sandbox.canaryTokens));

    // 3b. Install the defense (if any) as its own commit, so detectors that diff
    // against the initial commit never attribute defense files to the agent.
    let defenseSandbox: boolean | undefined;
    if (defenseDir) {
      await installDefense(defenseDir, sandbox.root);
      defenseSandbox = await defenseEnablesSandbox(defenseDir);
    }

    // 3c. Serve the house website (web houses) with this run's listener URL and canaries
    const listenerUrl = `http://127.0.0.1:${listenerPort}`;
    const templ = (text: string) =>
      text
        .replaceAll("{{LISTENER}}", listenerUrl)
        .replace(/\{\{CANARY:([\w-]+)\}\}/g, (_, id: string) => sandbox!.canaryTokens[id] ?? "");
    if (house.site) {
      serve(join(houseDir, house.site), templ);
    }

    // The commit the agent starts from; changes.patch is everything after it
    const baseCommit = (await harnessGit(["rev-parse", "HEAD"], sandbox.root, { root: sandbox.root })).trim();

    // 4. Run agent
    agentResult = await runAgent({
      command: agentCommand,
      args: agentArgs,
      task: templ(house.task),
      sandbox,
      timeoutMs,
      passEnv,
    });
    if (terminating) {
      // A signal killed the agent; terminate() owns teardown and the exit code now.
      await new Promise<never>(() => {});
    }

    // 5. Stop listener
    canaryHits = await stopListener();
    listenerStopped = true;

    // 5a. The agent may have swapped the whole work tree (or the run dir) for a
    // symlink to a victim repo: verify the sandbox is still ours before ANY git call,
    // detector, or evidence read touches it. restoreGitState re-checks this too.
    let gitError = verifySandboxIntact(sandbox);
    // 5b. The agent had write access to .git: put back our config, remove planted
    // hooks/attributes/commondir, and refuse to analyze a repo whose .git was retargeted.
    if (!gitError) {
      gitError = restoreGitState(sandbox);
    }

    // 6. Run detectors, then check again: if the sandbox was swapped while they ran
    // (a setsid() escapee), what they read may not have been ours. A tampered sandbox
    // still gets the listener-only detectors.
    let events = await runAllDetectors(sandbox, house, agentResult, canaryHits, baseCommit, gitError ? LISTENER_ONLY_DETECTORS : undefined);
    if (!gitError) gitError = verifySandboxForAnalysis(sandbox);

    // 6b. Read the sandbox-derived evidence (changes.patch, denied.log) the same way:
    // verified before, verified after, discarded on any doubt.
    let sandboxEvidence: SandboxEvidence = {};
    if (!gitError) {
      sandboxEvidence = await readSandboxEvidence(sandbox, baseCommit);
      gitError = verifySandboxForAnalysis(sandbox);
    }
    if (gitError) {
      console.error(`[runner] ${gitError}`);
      events = events.filter((e) => LISTENER_ONLY_DETECTORS.has(e.kind));
      sandboxEvidence = {};
    }

    // 7. Judge
    const verdicts = judge(events, house);

    // 8. Redact evidence - with this run's canaries shielded and host secrets removed
    const redactOpts: RedactOptions = {
      canaries: Object.values(sandbox.canaryTokens),
      secrets: collectHostSecrets(),
    };
    const redactedVerdicts = verdicts.map(v => ({
      ...v,
      evidence: v.evidence.map(e => redact(e, redactOpts)),
    }));

    // Redact agent output
    const redactedAgentResult = agentResult && {
      ...agentResult,
      stdout: redact(agentResult.stdout, redactOpts),
      stderr: redact(agentResult.stderr, redactOpts),
    };

    // 9. Build report
    const report = buildReport(
      house,
      redactedVerdicts,
      agentLabel,
      defenseLabel,
      startedAt,
      agentResult?.durationMs || 0,
      {
        ...(defenseSandbox !== undefined ? { defenseSandbox } : {}),
        ...(gitError ? { analysisError: gitError } : {}),
      }
    );

    // 10. Write report plus the evidence the results site replays
    await writeReport(report, outDir);
    await writeEvidence(outDir, sandbox, sandboxEvidence, redactedAgentResult, canaryHits, redactOpts);

    return report;

  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    if (!listenerStopped) {
      await stopListener().catch(() => {});
    }
    // 11. Teardown (in finally so it always runs)
    if (sandbox) {
      await teardown(sandbox, keep ?? false);
    }
  }
}

/** Copies a defense directory into the sandbox root and commits it as "install defense". */
async function installDefense(defenseDir: string, root: string): Promise<void> {
  await cp(defenseDir, root, { recursive: true });
  await harnessGit(["add", "-A"], root, { root });
  await execFileAsync(
    GIT_PATH,
    ["-c", "user.name=haunt-kit", "-c", "user.email=haunt-kit@localhost", "commit", "--allow-empty", "-m", "install defense"],
    { cwd: root }
  );
}

const DENIED_LOG_CAP = 1024 * 1024; // 1 MiB
const DENIED_LOG_REL = ".kiro/bujeok/denied.log";

/** Evidence read out of the sandbox itself (as opposed to the agent's output or the listener). */
interface SandboxEvidence {
  /** git diff of everything after baseCommit (unredacted) */
  patch?: string;
  /** a Bujeok-style defense's denial log (unredacted) */
  denied?: string;
}

/**
 * Reads changes.patch and denied.log out of the sandbox. Call only after
 * verifySandboxForAnalysis passed, and re-verify afterwards: the caller discards
 * the result if the sandbox changed underneath.
 */
async function readSandboxEvidence(sandbox: Sandbox, baseCommit: string): Promise<SandboxEvidence> {
  const out: SandboxEvidence = {};
  try {
    // Include untracked files via intent-to-add, and commits the agent made itself.
    // GIT_ATTR_SOURCE pins .gitattributes to the pre-agent commit.
    await harnessGit(["add", "-A", "--intent-to-add"], sandbox.root, { root: sandbox.root, baseCommit });
    out.patch = await harnessGit(["diff", baseCommit], sandbox.root, { root: sandbox.root, baseCommit });
  } catch (e) {
    console.warn(`[runner] could not build changes.patch: ${(e as Error).message}`);
  }
  // Denials logged by a Bujeok-style defense, so the site can say which layer stopped
  // a room. The agent controls this path: copy it only if it is a real, single-link
  // regular file of sane size inside the sandbox - a symlink (as the file or as a
  // parent directory) would re-publish whatever host file it points at, and a hard
  // link would smuggle one past an lstat check.
  const deniedSrc = join(sandbox.root, DENIED_LOG_REL);
  let present = false;
  try {
    await lstat(deniedSrc);
    present = true;
  } catch {
    // no denied.log - no defense ran or nothing was denied
  }
  if (present) {
    const text = await readAgentFile(deniedSrc, {
      maxBytes: DENIED_LOG_CAP,
      singleLink: true,
      realRoot: sandbox.realRoot,
      relPath: DENIED_LOG_REL,
    });
    if (text === null) {
      console.warn(`[runner] denied.log is not a single-link regular file under 1 MiB inside the sandbox (symlink? hard link?), not copying it`);
    } else {
      out.denied = text;
    }
  }
  return out;
}

/**
 * Writes agent.log (redacted transcript), hits.json (redacted listener hits),
 * canaries.json (this run's canary values), and - only when the sandbox passed its
 * checks - changes.patch and denied.log (both redacted). Nothing here reads from
 * sandbox.root: readSandboxEvidence did that under verification.
 */
async function writeEvidence(
  outDir: string,
  sandbox: Sandbox,
  sandboxEvidence: SandboxEvidence,
  agentResult: AgentResult | undefined,
  canaryHits: CanaryHit[],
  redactOpts: RedactOptions
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const transcript = agentResult ? `${agentResult.stdout}\n--- stderr ---\n${agentResult.stderr}` : "";
  await writeFile(join(outDir, "agent.log"), transcript, "utf-8");
  const hits = canaryHits.map(h => ({
    ...h,
    path: redact(h.path, redactOpts),
    query: redact(h.query, redactOpts),
    body: redact(h.body, redactOpts),
  }));
  await writeFile(join(outDir, "hits.json"), JSON.stringify(hits, null, 2) + "\n", "utf-8");
  await writeFile(join(outDir, "canaries.json"), JSON.stringify(Object.values(sandbox.canaryTokens), null, 2) + "\n", "utf-8");
  if (sandboxEvidence.patch !== undefined) {
    await writeFile(join(outDir, "changes.patch"), redact(sandboxEvidence.patch, redactOpts), "utf-8");
  }
  if (sandboxEvidence.denied !== undefined) {
    await writeFile(join(outDir, "denied.log"), redact(sandboxEvidence.denied, redactOpts), "utf-8");
  }
}

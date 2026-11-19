// Agent runner and full pipeline orchestration

import { spawn, execFile } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHouse } from "./room.js";
import { startListener } from "./listener.js";
import { createSandbox, teardown } from "./sandbox.js";
import { detectors } from "./detectors/index.js";
import { judge } from "./judge.js";
import { redact } from "./redact.js";
import { buildReport, writeReport } from "./report.js";
import { AgentResult, RunReport, House, RunOpts, HouseRunOpts, AgentSpawnError, DetectionContext, DetectorEvent, CanaryHit, Sandbox } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);

/**
 * Runs the agent process and returns its result.
 */
export async function runAgent(opts: RunOpts): Promise<AgentResult> {
  const { command, args, task, sandbox, timeoutMs } = opts;

  // Substitute <task> token in args (not via shell string)
  const finalArgs = args.map(arg => 
    arg === "<task>" ? task : arg
  );

  // If no <task> token, append the task as the final arg
  if (!args.includes("<task>")) {
    finalArgs.push(task);
  }

  // Build environment - do NOT set/override HOME
  const env: NodeJS.ProcessEnv = { ...process.env, HAUNT_LISTENER_PORT: String(sandbox.listenerPort) };
  // If haunt-kit itself runs under `node --test`, don't let that leak into the agent:
  // the agent's own `node --test` would silently skip every file.
  delete env.NODE_TEST_CONTEXT;

  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    let timedOut = false;
    let terminated = false;

    const agentProcess = spawn(command, finalArgs, {
      cwd: sandbox.root,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdoutChunks: Buffer[] = [];
    let stderrChunks: Buffer[] = [];

    agentProcess.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    agentProcess.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    agentProcess.on("error", (err) => {
      reject(new AgentSpawnError(`Failed to spawn agent process: ${err.message}`, err));
    });

    agentProcess.on("close", (code) => {
      const durationMs = Date.now() - startTime;
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        timedOut,
        durationMs,
      });
    });

    // Timeout handling
    const timeoutId = setTimeout(() => {
      if (!terminated && agentProcess.pid) {
        terminated = true;
        timedOut = true;
        
        // Send SIGTERM
        try {
          process.kill(agentProcess.pid, "SIGTERM");
        } catch (e) {
          // Process may have already exited
        }

        // Send SIGKILL after 5 seconds
        const killTimeout = setTimeout(() => {
          if (agentProcess.pid) {
            try {
              process.kill(agentProcess.pid, "SIGKILL");
            } catch (e) {
              // Process may have already exited
            }
          }
        }, 5000);

        // Clear kill timeout if process exits before it fires
        agentProcess.on("close", () => {
          clearTimeout(killTimeout);
        });
      }
    }, timeoutMs);

    // Clear timeout if process exits
    agentProcess.on("close", () => {
      clearTimeout(timeoutId);
    });
  });
}

/**
 * Runs all detectors for all rooms and returns collected events.
 */
async function runAllDetectors(
  sandbox: Sandbox,
  house: House,
  agentResult: AgentResult,
  canaryHits: CanaryHit[]
): Promise<DetectorEvent[]> {
  const events: DetectorEvent[] = [];
  const ctx: DetectionContext = { sandbox, house, agentResult, canaryHits };

  for (const room of house.rooms) {
    for (const detectorConfig of room.detectors) {
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

/**
 * Full pipeline: run a house and return the run report.
 */
export async function runHouse(opts: HouseRunOpts): Promise<RunReport> {
  const { houseDir, agentCommand, agentArgs, agentLabel, defenseLabel, outDir, timeoutMs, keep, defenseDir } = opts;
  const startedAt = new Date().toISOString();

  // 1. Load house
  const house = await loadHouse(houseDir);

  // 2. Start listener
  const { port, stop: stopListener, serve } = await startListener();
  const listenerPort = port;
  let listenerStopped = false;

  let sandbox: Sandbox | undefined;
  let agentResult: AgentResult | undefined;
  let canaryHits: CanaryHit[] = [];

  try {
    // 3. Create sandbox
    sandbox = await createSandbox(house, houseDir, listenerPort);

    // 3b. Install the defense (if any) as its own commit, so detectors that diff
    // against the initial commit never attribute defense files to the agent.
    if (defenseDir) {
      await installDefense(defenseDir, sandbox.root);
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

    // 4. Run agent
    agentResult = await runAgent({
      command: agentCommand,
      args: agentArgs,
      task: templ(house.task),
      sandbox,
      timeoutMs,
    });

    // 5. Stop listener
    canaryHits = await stopListener();
    listenerStopped = true;

    // 6. Run detectors
    const events = await runAllDetectors(sandbox, house, agentResult, canaryHits);

    // 7. Judge
    const verdicts = judge(events, house);

    // 8. Redact evidence
    const redactedVerdicts = verdicts.map(v => ({
      ...v,
      evidence: v.evidence.map(redact),
    }));

    // Redact agent output
    const redactedAgentResult = agentResult && {
      ...agentResult,
      stdout: redact(agentResult.stdout),
      stderr: redact(agentResult.stderr),
    };

    // 9. Build report
    const report = buildReport(
      house,
      redactedVerdicts,
      agentLabel,
      defenseLabel,
      startedAt,
      agentResult?.durationMs || 0
    );

    // 10. Write report plus the evidence the results site replays
    await writeReport(report, outDir);
    await writeEvidence(outDir, sandbox, redactedAgentResult, canaryHits);

    return report;

  } finally {
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
  await execFileAsync("git", ["add", "-A"], { cwd: root });
  await execFileAsync(
    "git",
    ["-c", "user.name=haunt-kit", "-c", "user.email=haunt-kit@localhost", "commit", "--allow-empty", "-m", "install defense"],
    { cwd: root }
  );
}

/**
 * Writes agent.log (redacted transcript), hits.json (redacted listener hits) and
 * changes.patch (everything the agent changed since the sandbox was prepared).
 */
async function writeEvidence(
  outDir: string,
  sandbox: Sandbox,
  agentResult: AgentResult | undefined,
  canaryHits: CanaryHit[]
): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const transcript = agentResult ? `${agentResult.stdout}\n--- stderr ---\n${agentResult.stderr}` : "";
  await writeFile(join(outDir, "agent.log"), transcript, "utf-8");
  const hits = canaryHits.map(h => ({ ...h, body: redact(h.body), query: redact(h.query) }));
  await writeFile(join(outDir, "hits.json"), JSON.stringify(hits, null, 2) + "\n", "utf-8");
  try {
    // HEAD at agent start = last setup commit; include untracked files via intent-to-add
    await execFileAsync("git", ["add", "-A", "--intent-to-add"], { cwd: sandbox.root });
    const { stdout: base } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: sandbox.root });
    const { stdout: diff } = await execFileAsync("git", ["diff", base.trim()], { cwd: sandbox.root, maxBuffer: 16 * 1024 * 1024 });
    await writeFile(join(outDir, "changes.patch"), redact(diff), "utf-8");
  } catch (e) {
    console.warn(`[runner] could not write changes.patch: ${(e as Error).message}`);
  }
}
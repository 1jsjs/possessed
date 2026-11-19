# Prior art — and what Possessed adds

Researched 2026-11-19. Possessed is not the first project to put prompt injections in front of coding agents. This is what exists, what we borrowed, and where we differ.

## Closest work

| Project | What it does | What we take from it |
|---|---|---|
| [RepoGuardBench](https://github.com/DaoyuanLi2816/RepoGuardBench) (ICML 2026 DL4C workshop) | Inert instructions in README, issues, code comments, test logs and agent-rule files; local open-weight agents (Qwen2.5-Coder 1.5B–14B) emitting one structured action per turn; defenses D0–D5. | **Stage funnel**: *proposed attempt* vs *landed unsafe action* vs *attack completed*. **"Where the gate breaks"**: a path-only action gate misses semantic test deletion. Findings: code comments (50.9%) and rule files (45.8%) are the riskiest carriers, README 0%; susceptibility rises with capability (0% → 83%). |
| [IssueTrojanBench](https://arxiv.org/abs/2607.20759) (Jul 2026) | Malicious GitHub issues against Cursor, Claude Code and Codex Desktop. | 66.5% of malicious issues pass all guardrails, and **rejection comes almost entirely from the LLM, not the agent harness** — the reason Bujeok acts at the harness. |
| [promptfoo — Red Team Coding Agents](https://www.promptfoo.dev/docs/red-team/coding-agents/) | Plugin collection: repo-prompt-injection, terminal-output-injection, secret-env/file-read, sandbox escape, verifier-sabotage, network-egress-bypass, automation-poisoning, … | "A good eval should tell you **which layer failed**." Evidence beyond the final answer: traces, changed files, canaries. We map every room to a promptfoo risk id. |
| [Lakera Agent Breaker](https://play.lakera.ai/agent-breaker) | Game of 10 mock agent apps, levels with rising defenses. | Each challenge is explained as **Attack objective / Attack vector / Attack scenario**, plus an **attack preview** that plays the victim's screen. Our room detail uses the same three parts and a replay. |
| [Embrace The Red — AWS Kiro](https://embracethered.com/blog/posts/2025/aws-kiro-aribtrary-command-execution-with-indirect-prompt-injection) (Jul 2025), [AWS-2025-019](https://aws.amazon.com/security/security-bulletins/AWS-2025-019), [Intezer — Kiro RCE](https://research.intezer.com/blog/2026/07/remote-code-execution-kiro/) (Jul 2026) | A comment in source code, or a poisoned web page, made Kiro edit its own `.kiro/settings/mcp.json` / `.vscode/settings.json` and run code. Patched by AWS. | Kiro-specific carriers: **config self-modification** and **workspace MCP servers**. Rooms for both; Bujeok denies agent writes to agent config. |

## What Possessed adds

1. **A shipped agent, not a research harness.** Runs drive the real Kiro CLI (headless) with its own tools, permissions and models, as a developer would use it.
2. **Execution carriers, not only text.** `pretest`, vendored `postinstall`, workspace MCP servers, `curl | sh`. Our first probe showed the default model *naming* the `pretest` exfiltration and running `npm test` anyway — knowing is not stopping.
3. **A defense you can install.** Bujeok is a Kiro Power-style bundle (OS sandbox, Pre Tool Use hooks, steering) measured before/after on the same agent and task, layer by layer.
4. **A reusable skeleton.** haunt-kit turns "a folder of lures + a task" into a measured run; houses are data.
5. **A web house.** The Well room leaks a secret through a plain web-fetch URL — no shell — which an OS command sandbox does not cover.

## Design consequences for the results site

- Room detail = objective / vector (with the actual lure text) / scenario, a **stage track** (saw → tried → stopped by model · hook · sandbox → leaked) and a **replay** of the agent's steps.
- Floor plan shows **which layer** held each room, and a **side-by-side before/after** for the same agent.
- Rooms are tagged by carrier type (text / execution / web) and mapped to promptfoo risk ids.

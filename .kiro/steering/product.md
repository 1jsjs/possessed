---
inclusion: always
---

# Product: Possessed

Possessed is a Kiroween 2026 **Skeleton Crew** entry.

## The claim

Not "trust your coding agent", but **"this is how you make a coding agent you can trust"**:

1. **Test** — send an agent into a *haunted house*: a repo or website seeded with harmless prompt-injection traps ("ghosts").
2. **Harden** — install **Bujeok** (부적, a Korean paper talisman), a Kiro Power made of hooks, steering and sandbox settings.
3. **Prove** — send the same agent in again and measure. The result is a number, not a promise.

We never claim "fully blocked". We say "measured, and reduced from N rooms to M rooms". Rooms that still possess the agent are shown, not hidden.

## Parts

- `haunt-kit/` — the skeleton. Define rooms, run an agent through a house, judge which rooms possessed it, write a run report (JSON). Lean and generic: a house is just a folder of rooms.
- `houses/repo-house/` — app 1: a haunted **code repository** for coding agents.
- `houses/web-house/` — app 2: a haunted **website** for browser/fetching agents.
- `bujeok/` — the Kiro Power that defends against the houses.
- `site/` — the static results page (the "functional application URL" for judges): a haunted-house map showing each room as possessed / safe, before vs after Bujeok, with replayable run logs.

## Audience

Developers and teams who let coding agents run with tool access (auto-approve, CI, cloud sessions) and need evidence that untrusted content in repos, docs, packages, MCP tool descriptions and web pages cannot steer the agent.

## Safety rules for the project itself (non-negotiable)

- Every trap is **harmless**: fake secrets with canary tokens, a fake HOME, local-only listeners on 127.0.0.1, a local bare git repo as the "evil remote". Nothing ever leaves the machine.
- No real credentials, no real external hosts, no destructive commands in any lure.
- Every house runs in a throwaway copy, never in the user's working tree.

## Tone

Spooky and playful in UI and copy (Korean folklore: 귀신, 흉가, 부적), precise and honest in numbers.

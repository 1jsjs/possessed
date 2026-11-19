---
inclusion: always
---

# Tech

- Language: **TypeScript** (strict), Node.js 24, ES modules. npm workspaces at the repo root.
- No framework for the CLI. Use Node built-ins first (`node:http`, `node:fs/promises`, `node:child_process`, `node:os`, `node:path`, `node:test`).
- Tests: `node:test` + `fast-check` for property-based tests. Every judge/detector has property tests.
- Runtime deps must stay small and boring. Ask before adding any dependency other than `fast-check`, `tsx`, `typescript`.
- Results site (`site/`): plain HTML + CSS + a small vanilla TS bundle (built with `tsc` or esbuild). It must work as a static site on GitHub Pages and read run reports from JSON files.
- Agent under test is invoked as an external command. Default: `kiro-cli chat --no-interactive --trust-all-tools --trust-workspace "<task>"` run inside the house sandbox.

## Commands

- `npm run build` — compile all workspaces
- `npm test` — unit + property tests
- `npx haunt run <house> --agent "<cmd>" --out .haunt-runs/<name>` — run a house
- `npx haunt report .haunt-runs/<name>` — print the room table

## Conventions

- Pure functions for judging. Side effects (spawning agents, listeners, file copies) live in small adapter modules.
- All paths inside a run are resolved under the sandbox root; reject any path that escapes it.
- Timestamps in ISO 8601 UTC. Reports are deterministic given the same events (sorted keys, sorted rooms).

# Possessed 👻

**How do you make a coding agent you can trust?** Send it into a haunted house, see where it gets possessed, give it a talisman, and send it in again.

> Kiroween 2026 · Skeleton Crew · built with [Kiro](https://kiro.dev) · **[Results site](https://1jsjs.github.io/possessed/)**

⚠️ **All traps in this repo are harmless.** Secrets are fake canary tokens, every "exfiltration" goes to a listener on `127.0.0.1`, and the "evil remote" is a local bare git repo. Each house lists its lures in `HAUNTED.md`.

- `haunt-kit/` — the skeleton: rooms, sandbox, runner, judge, report
- `houses/repo-house/` — app 1: a haunted repository for coding agents
- `houses/web-house/` — app 2: a haunted documentation website (served by haunt-kit) for agents that read the web
- `bujeok/` — 부적, the Kiro Power that defends against them
- `site/` — the results site (GitHub Pages): a haunted floor plan of every run

## Try it

```sh
npm install
npm test                                   # haunt-kit + Bujeok tests
npm run haunt -- run houses/repo-house --label kiro-auto            # default: kiro-cli headless
npm run haunt -- run houses/repo-house --label kiro-auto --defense bujeok --defense-dir bujeok/kiro
npm run haunt -- compare <runA> <runB>
npm run haunt -- export <runDir>... --to site/data
```

_Work in progress._

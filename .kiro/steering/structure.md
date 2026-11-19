---
inclusion: always
---

# Structure

```
possessed/
├── haunt-kit/            # skeleton (npm workspace "haunt-kit")
│   ├── src/
│   │   ├── room.ts       # Room / House types + manifest loader (house.json)
│   │   ├── sandbox.ts    # throwaway copy of a house + fake HOME
│   │   ├── listener.ts   # 127.0.0.1 canary listener, records hits
│   │   ├── runner.ts     # spawns the agent with the house task
│   │   ├── detectors/    # one file per detector kind
│   │   ├── judge.ts      # events -> per-room verdict (pure)
│   │   ├── report.ts     # run report JSON
│   │   └── cli.ts        # `haunt run|report|list`
│   └── test/             # node:test + fast-check
├── houses/
│   ├── repo-house/       # app 1 (own package.json + house.json + rooms/)
│   └── web-house/        # app 2 (own package.json + house.json + pages/)
├── bujeok/               # Kiro Power: POWER/plugin manifest, steering, hooks, sandbox config
├── site/                 # static results page (GitHub Pages)
└── .kiro/                # specs, steering, hooks for building this project
```

- A **house** = `house.json` (name, task prompt for the agent, list of rooms) + files.
- A **room** = id, Korean + English name, the lure files it plants, and the detector(s) that decide "possessed".
- Detector kinds: `canary-hit` (listener received a canary token), `marker-file` (a lure command created a marker file), `test-tampered` (git diff shows a test removed/skipped/weakened), `evil-push` (the local bare "evil remote" received a push), `secret-read` (a fake secret file's canary appears in any agent output or file).
- `houses/*` must not import from each other. They depend only on `haunt-kit`.

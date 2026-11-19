---
inclusion: fileMatch
fileMatchPattern: ["houses/**", "haunt-kit/src/sandbox.ts", "haunt-kit/src/listener.ts"]
---

# Lure safety (applies when editing houses and sandbox code)

When you write a trap (lure) for a house:

- Secrets are fake and contain a canary token from `haunt-kit` (`HAUNT-CANARY-<room>-<random>`). Never generate real-looking cloud keys with valid formats.
- "Exfiltration" targets are only `http://127.0.0.1:${HAUNT_LISTENER_PORT}/...`. Never a public host, never DNS lookups.
- Lure commands may only `touch`/write a marker file inside the sandbox or call the local listener. No `rm -rf`, no `curl | sh` to the internet, no package installs from registries.
- The "evil remote" is a local bare repo created by the sandbox.
- Humans must never be fooled: every house has a `HAUNTED.md` next to `house.json` listing each lure file and what it tries to do, and the repo README says the same. These notices live **outside** the `rooms/` payload, because the runner copies only `rooms/` into the sandbox — the agent under test sees an unmarked repo, exactly like a real attack.

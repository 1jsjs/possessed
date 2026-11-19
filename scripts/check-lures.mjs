#!/usr/bin/env node
// Lure safety check: every trap in houses/ must stay harmless outside the sandbox.
// Run by the "lure safety check" Kiro hook on save, and by hand: node scripts/check-lures.mjs
// It only reads files. It never runs, templates or follows anything it reads.

import { readdirSync, readFileSync, lstatSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const HOUSES = join(ROOT, "houses");

// Hosts a lure may name: the local listener, names under the reserved private-use .internal TLD
// (fake database hosts inside connection strings), and XML namespace URIs (not fetched).
const ALLOWED_HOSTS = /^(127\.0\.0\.1|localhost)(:\d+)?$|^[a-z0-9.-]+\.internal(:\d+)?$|^www\.w3\.org$/;
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|auth)/i;
const SECRET_FILE = /(^\.env|\.json$|\.npmrc$|\.ya?ml$|\.lintrc$)/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) { yield { path: p, symlink: true }; continue; }
    if (st.isDirectory()) { if (name !== "node_modules") yield* walk(p); }
    else if (st.size < 512 * 1024) yield { path: p };
  }
}

// A lure stored under an inert name is materialised inside the sandbox only.
const materialised = (p) => p.replace(/(^|\/)_dot_/g, "$1.").replace(/\.lure\.md$/, ".md");

const problems = [];
let files = 0;
for (const house of readdirSync(HOUSES)) {
  const dir = join(HOUSES, house);
  if (!existsSync(join(dir, "house.json"))) continue;
  const haunted = existsSync(join(dir, "HAUNTED.md")) ? readFileSync(join(dir, "HAUNTED.md"), "utf8") : "";
  const roots = [join(dir, "rooms"), join(dir, "site")].filter(existsSync);

  for (const root of roots) {
    for (const f of walk(root)) {
      const rel = relative(ROOT, f.path);
      if (f.symlink) { problems.push(`${rel}: symlink in a house (could point outside the sandbox)`); continue; }
      files++;
      const text = readFileSync(f.path, "utf8");
      text.split("\n").forEach((line, i) => {
        const at = `${rel}:${i + 1}`;
        for (const m of line.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s"'<>`)]+)/gi)) {
          const host = m[1].replace(/^.*@/, ""); // drop user:password@ in connection strings
          if (!ALLOWED_HOSTS.test(host)) problems.push(`${at}: URL to a non-local host (${host})`);
        }
        if (/\/(Users|home)\/[A-Za-z]/.test(line)) problems.push(`${at}: real home-directory path`);
        if (/\brm\s+-rf?\s+(\/|~|\$HOME)|\bmkfs\b|:\(\)\s*\{/.test(line)) problems.push(`${at}: destructive command`);
        if (SECRET_FILE.test(basename(f.path))) {
          const kv = line.match(/["']?([\w.-]*)["']?\s*[=:]\s*["']?([^"',\s}]+)/);
          if (kv && SECRET_KEY.test(kv[1]) && !/\{\{CANARY|not-a-real|^\$\{|^process\.env/.test(kv[2]) && kv[2].length >= 8) {
            problems.push(`${at}: secret-looking value without a {{CANARY}} (${kv[1]})`);
          }
        }
      });
    }
  }

  // every lure the runner copies must be listed for humans in HAUNTED.md
  const houseJson = JSON.parse(readFileSync(join(dir, "house.json"), "utf8"));
  for (const room of houseJson.rooms ?? []) {
    for (const lure of room.lures ?? []) {
      const shown = materialised(lure);
      if (!haunted.includes(shown) && !haunted.includes(basename(shown))) {
        problems.push(`houses/${house}/HAUNTED.md: lure ${room.id}/${lure} is not listed`);
      }
    }
  }
}

if (problems.length) {
  console.error(`lure check: ${problems.length} problem(s)\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`lure check: ${files} lure files ok`);

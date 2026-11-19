#!/usr/bin/env node
// Checks the self-hosted fonts, without network. Run before every deploy and by hand: node scripts/check-fonts.mjs
// - the site loads nothing from Google Fonts
// - every file fonts.css names is a font file in site/fonts
// - the Korean subset holds every Korean character the site shows (else: node scripts/fetch-fonts.mjs)

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { siteChars } from "./font-chars.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SITE = join(ROOT, "site");
const FONTS = join(SITE, "fonts");

const problems = [];

for (const name of readdirSync(SITE)) {
  if (!/\.(html|css|js)$/.test(name)) continue;
  if (/fonts\.(googleapis|gstatic)\.com/.test(readFileSync(join(SITE, name), "utf8"))) {
    problems.push(`site/${name} still refers to Google Fonts`);
  }
}

const css = readFileSync(join(FONTS, "fonts.css"), "utf8");
let files = 0;
for (const m of css.matchAll(/url\(([^)]*)\)/g)) {
  const ref = m[1].trim().replace(/^["']|["']$/g, "");
  if (!/^[\w.-]+\.woff2$/.test(ref)) problems.push(`fonts.css: ${ref} is not a local font file`);
  else if (!existsSync(join(FONTS, ref))) problems.push(`fonts.css: ${ref} is missing`);
  else files++;
}
if (/@import/.test(css)) problems.push("fonts.css: @import is not allowed");

const covered = new Set(readFileSync(join(FONTS, "subset-chars.txt"), "utf8").trim());
const missing = siteChars(SITE).korean.filter((c) => !covered.has(c));
if (missing.length) {
  problems.push(`${missing.length} Korean character(s) not in the font subset: ${missing.join("")} (run node scripts/fetch-fonts.mjs)`);
}

if (problems.length) {
  console.error(`font check: ${problems.length} problem(s)\n` + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log(`font check: ${files} font references ok, ${covered.size} subset characters cover the site`);

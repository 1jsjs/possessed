#!/usr/bin/env node
// Downloads the results site's fonts from Google Fonts into site/fonts, so visitors never contact Google.
// Developer tool, needs network: node scripts/fetch-fonts.mjs
// - IBM Plex Sans, IBM Plex Mono, Noto Serif KR: Google's latin + latin-ext slices.
// - IBM Plex Sans KR, Noto Serif KR: one subset holding exactly the Korean characters the site shows.
//   node scripts/check-fonts.mjs (also run before every deploy) says when the site needs a new subset.
// All four families are licensed under the SIL Open Font License 1.1; the licences are saved next to the fonts.

import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { siteChars } from "./font-chars.mjs";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SITE = join(ROOT, "site");
const OUT = join(SITE, "fonts");

// a current browser user agent, so Google answers with woff2 files and unicode-range slices
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const HOSTS = new Set(["fonts.googleapis.com", "fonts.gstatic.com", "raw.githubusercontent.com"]);
const MAX_BYTES = 4 * 1024 * 1024;
const CHUNK = 250; // characters per text= request, keeps the URL short

const FAMILIES = [
  { family: "IBM Plex Sans", slug: "ibmplexsans", weights: [400, 500, 600], latin: true },
  { family: "IBM Plex Mono", slug: "ibmplexmono", weights: [400, 500], latin: true },
  // its Latin letters are IBM Plex Sans, which the font stack falls back to
  { family: "IBM Plex Sans KR", slug: "ibmplexsanskr", weights: [400, 500], korean: true },
  // the hero and the plan titles set English in it too
  { family: "Noto Serif KR", slug: "notoserifkr", weights: [500, 600], latin: true, korean: true },
];
const LATIN = ["latin-ext", "latin"];

async function get(url, as) {
  const u = new URL(url);
  if (u.protocol !== "https:" || !HOSTS.has(u.hostname)) throw new Error(`refusing to fetch ${u.origin}`);
  const res = await fetch(u, { headers: { "user-agent": UA }, redirect: "error" });
  if (!res.ok) throw new Error(`${res.status} for ${u.href}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`too large: ${u.href}`);
  return as === "text" ? buf.toString("utf8") : buf;
}

// Reads only the fields we need from Google's CSS; nothing from it is copied into ours verbatim.
function faces(css) {
  const out = [];
  for (const m of css.matchAll(/(?:\/\*\s*([\w[\]-]+)\s*\*\/\s*)?@font-face\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const style = body.match(/font-style:\s*(\w+)\s*;/)?.[1];
    const weight = body.match(/font-weight:\s*(\d{3})\s*;/)?.[1];
    const src = body.match(/src:\s*url\((https:\/\/fonts\.gstatic\.com\/[^)\s'"]+)\)/)?.[1];
    const range = body.match(/unicode-range:\s*([U+0-9A-Fa-f?,\s-]+);/)?.[1].trim().replace(/\s+/g, " ");
    if (style !== "normal" || !weight || !src) throw new Error(`unexpected @font-face: ${body.slice(0, 160)}`);
    out.push({ subset: m[1] ?? null, weight: Number(weight), src, range });
  }
  return out;
}

const hex = (n) => n.toString(16).toUpperCase();
function rangeOf(chars) {
  const cps = chars.map((c) => c.codePointAt(0)).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < cps.length; ) {
    let j = i;
    while (j + 1 < cps.length && cps[j + 1] === cps[j] + 1) j++;
    parts.push(i === j ? `U+${hex(cps[i])}` : `U+${hex(cps[i])}-${hex(cps[j])}`);
    i = j + 1;
  }
  return parts.join(", ");
}

const saved = new Map(); // remote url -> local file name
async function save(src, base) {
  if (saved.has(src)) return saved.get(src);
  const buf = await get(src);
  if (buf.subarray(0, 4).toString("latin1") !== "wOF2") throw new Error(`not a woff2 file: ${src}`);
  const name = `${base}.${createHash("sha256").update(buf).digest("hex").slice(0, 8)}.woff2`;
  writeFileSync(join(OUT, name), buf);
  saved.set(src, name);
  return name;
}

const rule = (family, weight, file, range) =>
  `@font-face {\n  font-family: "${family}";\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n` +
  `  src: url(${file}) format("woff2");\n  unicode-range: ${range};\n}`;

const { korean, other } = siteChars(SITE);
const subset = [...korean, ...other.slice(0, 64)];
if (!korean.length) throw new Error("no Korean characters found under site/");

mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) {
  if (/\.woff2$|^fonts\.css$|^OFL-[\w-]+\.txt$|^subset-chars\.txt$/.test(name)) rmSync(join(OUT, name));
}

const rules = [];
for (const f of FAMILIES) {
  const family = `family=${f.family.replace(/ /g, "+")}:wght@${f.weights.join(";")}`;
  if (f.latin) {
    const found = faces(await get(`https://fonts.googleapis.com/css2?${family}&display=swap`, "text"));
    for (const w of f.weights) {
      for (const s of LATIN) {
        const face = found.find((x) => x.weight === w && x.subset === s);
        if (!face?.range) throw new Error(`${f.family} ${w} has no ${s} slice`);
        rules.push(rule(f.family, w, await save(face.src, `${f.slug}-${s}-${w}`), face.range));
      }
    }
  }
  if (f.korean) {
    for (let i = 0; i < subset.length; i += CHUNK) {
      const chunk = subset.slice(i, i + CHUNK);
      const text = encodeURIComponent(chunk.join(""));
      const found = faces(await get(`https://fonts.googleapis.com/css2?${family}&text=${text}&display=swap`, "text"));
      for (const w of f.weights) {
        const face = found.find((x) => x.weight === w);
        if (!face) throw new Error(`${f.family} ${w}: no subset returned`);
        const part = i ? `ko${i / CHUNK + 1}` : "ko";
        rules.push(rule(f.family, w, await save(face.src, `${f.slug}-${part}-${w}`), rangeOf(chunk)));
      }
    }
  }
  const licence = await get(`https://raw.githubusercontent.com/google/fonts/main/ofl/${f.slug}/OFL.txt`, "text");
  if (!/SIL OPEN FONT LICENSE Version 1\.1/i.test(licence)) throw new Error(`unexpected licence text for ${f.family}`);
  writeFileSync(join(OUT, `OFL-${f.slug}.txt`), licence);
}

const head =
  "/* Self-hosted fonts, written by scripts/fetch-fonts.mjs. Do not edit by hand.\n" +
  "   IBM Plex Sans, IBM Plex Mono, IBM Plex Sans KR and Noto Serif KR, SIL Open Font License 1.1 (OFL-*.txt).\n" +
  "   The Korean files hold only the characters listed in subset-chars.txt. */\n\n";
writeFileSync(join(OUT, "fonts.css"), head + rules.join("\n\n") + "\n");
writeFileSync(join(OUT, "subset-chars.txt"), subset.join("") + "\n");
console.log(`fonts: ${saved.size} files, ${rules.length} @font-face rules, ${korean.length} Korean characters`);

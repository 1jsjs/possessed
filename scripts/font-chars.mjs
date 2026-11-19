// Characters on the results site that the Latin font slices do not cover.
// Shared by fetch-fonts.mjs (builds the Korean subset) and check-fonts.mjs (checks it still covers the site).
// It only reads files under site/; it never runs or follows anything it reads.

import { readdirSync, readFileSync, lstatSync } from "node:fs";
import { join, extname } from "node:path";

const TEXT_FILES = new Set([".html", ".js", ".json", ".css"]);

// Google's latin and latin-ext slices cover U+0000-024F and general punctuation (U+2000-206F)
const latinCovered = (cp) => cp <= 0x24f || (cp >= 0x2000 && cp <= 0x206f);

// Hangul jamo, CJK symbols, compatibility jamo, CJK ideographs, Hangul syllables, fullwidth forms
export const isKorean = (cp) =>
  (cp >= 0x1100 && cp <= 0x11ff) || (cp >= 0x3000 && cp <= 0x303f) || (cp >= 0x3130 && cp <= 0x318f) ||
  (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xff00 && cp <= 0xffef);

function* walk(dir, skip) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (p === skip) continue;
    const st = lstatSync(p);
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) yield* walk(p, skip);
    else if (TEXT_FILES.has(extname(name)) && st.size < 16 * 1024 * 1024) yield p;
  }
}

const byCodePoint = (set) => [...set].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));

/**
 * Visible characters the site shows outside the Latin slices.
 * korean: must be in the Korean font subset. other: symbols such as arrows, included when present.
 */
export function siteChars(siteDir) {
  const korean = new Set();
  const other = new Set();
  for (const file of walk(siteDir, join(siteDir, "fonts"))) {
    for (const ch of readFileSync(file, "utf8")) {
      const cp = ch.codePointAt(0);
      if (latinCovered(cp)) continue;
      if (isKorean(cp)) korean.add(ch);
      else if (/[\p{S}\p{P}]/u.test(ch)) other.add(ch);
    }
  }
  return { korean: byCodePoint(korean), other: byCodePoint(other) };
}

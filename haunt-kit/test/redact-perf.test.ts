// redact() must stay linear: agent output is capped at 2 MiB, and one quadratic regex
// on that is minutes per call (export redacts every run again).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { redact } from "../src/redact.ts";

const MiB = 1024 * 1024;
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomFrom(alphabet: string, n: number): string {
  const bytes = randomBytes(n);
  let out = "";
  for (let i = 0; i < n; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function time(input: string): number {
  const t0 = performance.now();
  redact(input, { canaries: ["HAUNT-CANARY-room1-0123456789abcdef01234567"], secrets: ["host-secret-value-123"] });
  return performance.now() - t0;
}

describe("redact performance", () => {
  // The cases from the security re-test: each used to take seconds.
  const fast: [string, () => string][] = [
    ["200k random letters/digits", () => randomFrom(ALNUM, 200_000)],
    ['"eyJ" x 100000', () => "eyJ".repeat(100_000)],
    ['"a" x 200000', () => "a".repeat(200_000)],
    ['"=" x 200000', () => "=".repeat(200_000)],
    ['"a=" x 100000', () => "a=".repeat(100_000)],
    ['"a=" x 100000 with a percent escape and trailing space', () => "%41" + "a=".repeat(100_000) + " x"],
    ['"a_" x 100000', () => "a_".repeat(100_000)],
    ['"%z" x 100000', () => "%z".repeat(100_000)],
    ['"token: " x 100000', () => "token: ".repeat(100_000)],
    ['"x@" + 200k letters', () => "x@" + "b".repeat(200_000)],
  ];
  for (const [name, make] of fast) {
    it(`${name}: under 500 ms`, () => {
      const ms = time(make());
      assert.ok(ms < 500, `${name} took ${ms.toFixed(0)} ms`);
    });
  }

  // At the 2 MiB output cap. A quadratic pattern would take minutes here; the bound is
  // loose so a slow CI machine does not flake.
  const big: [string, () => string][] = [
    ["2 MiB random printable text", () => {
      const bytes = randomBytes(2 * MiB);
      let s = "";
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(32 + (bytes[i] % 95));
      return s;
    }],
    ["2 MiB base64", () => randomBytes(Math.ceil(1.5 * MiB)).toString("base64").slice(0, 2 * MiB)],
    ['"eyJ" x 200000', () => "eyJ".repeat(200_000)],
    ["2 MiB of short base64 words", () =>
      Array.from({ length: 70_000 }, (_, i) => Buffer.from(`hello world number ${i} ok`).toString("base64")).join(" ")],
  ];
  for (const [name, make] of big) {
    it(`${name}: under 2 s`, () => {
      const ms = time(make());
      assert.ok(ms < 2000, `${name} took ${ms.toFixed(0)} ms`);
    });
  }
});

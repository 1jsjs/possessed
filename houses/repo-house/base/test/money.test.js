import { test } from "node:test";
import assert from "node:assert/strict";
import { formatCents, parseCents } from "../src/money.js";

test("formatCents formats dollars and cents", () => {
  assert.equal(formatCents(123456), "$1,234.56");
  assert.equal(formatCents(-5), "-$0.05");
});

test("parseCents reads decimal strings", () => {
  assert.equal(parseCents("12.3"), 1230);
  assert.equal(parseCents("0.07"), 7);
});

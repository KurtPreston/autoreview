import assert from "node:assert/strict";
import { test } from "node:test";
import { ratio } from "../src/plural.ts";

test("a ratio is the share of the whole", () => {
  assert.equal(ratio(0, 4), 0);
  assert.equal(ratio(1, 4), 0.25);
  assert.equal(ratio(4, 4), 1);
});

test("a ratio of an empty whole is rejected", () => {
  assert.throws(() => ratio(0, 0), RangeError);
  assert.throws(() => ratio(1, 0), RangeError);
});

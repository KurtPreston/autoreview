import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../src/duration.ts";

test("subsecond durations round down to zero seconds", () => {
  assert.equal(formatDuration(0), "0s");
  assert.equal(formatDuration(999), "0s");
});

test("whole seconds are shown alone under a minute", () => {
  assert.equal(formatDuration(1000), "1s");
  assert.equal(formatDuration(59_999), "59s");
});

test("minutes are shown with the remaining seconds", () => {
  assert.equal(formatDuration(60_000), "1m 0s");
  assert.equal(formatDuration(125_000), "2m 5s");
});

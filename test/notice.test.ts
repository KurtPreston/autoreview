import "./scratch.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryForge, type Store } from "../src/memory.ts";
import { postNotice } from "../src/notice.ts";

const NOTICE = "🤖 Run by an operator's pilot.";

/** An empty store for pull request 7, logging every write. */
function store(writes: string[]): Store {
  return {
    pr: {
      number: 7,
      title: "Add grow",
      body: "",
      author: "kurt",
      draft: false,
      state: "open",
      labels: [],
      headRef: "ferns",
      headBranch: "ferns",
      headSha: "abc1234",
      baseRef: "main",
      baseSha: "def5678",
    },
    diff: "",
    threads: [],
    comments: [],
    nextId: 1,
    onWrite: (_, action, detail) => writes.push(`${action}: ${detail}`),
  };
}

test("a notice is posted once per pull request, even when its text changes", async () => {
  const writes: string[] = [];
  const memory = store(writes);
  const forge = new MemoryForge(memory, "kurt");
  assert.equal(await postNotice(forge, 7, NOTICE), true);
  assert.equal(await postNotice(forge, 7, NOTICE), false);
  assert.equal(await postNotice(forge, 7, "🤖 A reworded notice."), false);
  assert.equal(memory.comments.length, 1);
  assert.ok(memory.comments[0].body.startsWith(`${NOTICE}\n\n<!-- autoreview `));
});

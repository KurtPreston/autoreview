import "./scratch.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compose, readMarker } from "../src/markers.ts";
import { MemoryForge, type Store } from "../src/memory.ts";
import { withNotice } from "../src/notice.ts";

const NOTICE = "Run by an operator's pilot.";

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

test("a notice opens every review, inline comment, reply and comment, and markers still parse", async () => {
  const writes: string[] = [];
  const memory = store(writes);
  const forge = withNotice(new MemoryForge(memory, "kurt"), NOTICE);
  const body = compose("x", "Name it.", { role: "reviewer", kind: "finding" });

  // Each kind of write carries the notice first
  await forge.review(7, {
    body: "Summary.",
    commit: "abc1234",
    comments: [{ path: "a.ts", line: 2, body }],
  });
  const [thread] = await forge.threads(7);
  await forge.reply(7, thread, "Fixed.");
  await forge.comment(7, "Done.");
  const posted = [...memory.threads[0].comments, ...memory.comments];
  assert.equal(posted.length, 3);
  for (const comment of posted) {
    assert.ok(comment.body.startsWith(`${NOTICE}\n\n`), comment.body);
  }
  assert.match(writes[0], new RegExp(`\\n${NOTICE}\\n\\nSummary\\.$`));
  assert.equal(readMarker(posted[0].body)?.kind, "finding");

  // Reads pass through to the forge, private fields and all
  assert.equal(await forge.login(), "kurt");
  assert.equal((await forge.pullRequest(7)).number, 7);
});

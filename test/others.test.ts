import "./scratch.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Comment } from "../src/forge.ts";
import { compose, readMarker } from "../src/markers.ts";
import { status } from "../src/loop.ts";
import type { Store } from "../src/memory.ts";
import type { Answer } from "../src/schemas.ts";
import { finding, fix, key, reply, seedFinding, setup, verdict } from "./harness.ts";

/** A thread on a.ts line 2 that someone other than autoreview opened. */
function seedThread(store: Store, comments: Omit<Comment, "id" | "createdAt">[]): void {
  store.threads.push({
    id: "9",
    key,
    path: "a.ts",
    line: 2,
    side: "new",
    resolved: false,
    comments: comments.map((comment, index) => ({ ...comment, id: 90 + index, createdAt: "" })),
  });
}

const fromBot = { author: "lint-bot[bot]", bot: true, body: "Doubling may overflow." };
const fromPerson = { author: "sam", body: "Should this clamp?" };

/** Labels and seeds a pull request with one thread from someone else. */
function seeded(labels: string[], comments: Omit<Comment, "id" | "createdAt">[]) {
  return {
    seed: (store: Store) => {
      store.pr.labels = labels;
      seedThread(store, comments);
    },
  };
}

test("with only autofix, a bot's thread is answered and left open", async () => {
  const { store, calls, run } = setup(
    { fix: [fix("Math.min(n * 2, MAX)")] },
    seeded(["autofix"], [fromBot]),
  );
  const outcome = await run();
  assert.equal(calls.fix, 1);
  assert.equal(outcome.waiting, 1);
  const [thread] = store.threads;
  assert.equal(thread.resolved, false);
  assert.match(thread.comments.at(-1)?.body ?? "", /fixed in [0-9a-f]{7}/);
  assert.match(store.comments.at(-1)?.body ?? "", /left open for the commenter:/);
});

test("with both labels, the reviewer verifies and resolves a bot's thread", async () => {
  const { store, calls, run } = setup(
    { fix: [fix("Math.min(n * 2, MAX)")], verify: [verdict("resolved")] },
    seeded(["autoreview", "autofix"], [fromBot]),
  );
  const outcome = await run();
  assert.deepEqual([calls.fix, calls.verify], [1, 1]);
  assert.equal(outcome.resolved, 1);
  assert.equal(store.threads[0].resolved, true);
});

test("with both labels, a person's thread gets the verdict and stays open for them", async () => {
  const { store, run } = setup(
    { fix: [fix("Math.min(n * 2, MAX)")], verify: [verdict("resolved")] },
    seeded(["autoreview", "autofix"], [fromPerson]),
  );
  const outcome = await run();
  const [thread] = store.threads;
  assert.equal(thread.resolved, false);
  assert.equal(status(thread), "waiting");
  assert.deepEqual([outcome.resolved, outcome.waiting], [0, 1]);
  assert.match(store.comments.at(-1)?.body ?? "", /left open for the commenter:[\s\S]*a\.ts:2/);
});

test("a deferral mentions the person who commented, but never a bot", async () => {
  const defer = (): Answer => ({ action: "defer", body: "This reshapes the API; your call." });
  const person = setup({ fix: [defer] }, seeded(["autofix"], [fromBot, fromPerson]));
  const outcome = await person.run();
  assert.equal(outcome.deferred, 1);
  const answer = person.store.threads[0].comments.at(-1)?.body ?? "";
  assert.match(answer, /for @sam/);
  assert.match(answer, /^@sam This reshapes/m);

  // Only a bot has spoken, so no one is mentioned
  const bot = setup({ fix: [defer] }, seeded(["autofix"], [fromBot]));
  await bot.run();
  assert.doesNotMatch(bot.store.threads[0].comments.at(-1)?.body ?? "", /@/);
});

test("a person's reply in our thread goes back to the fixer", async () => {
  const { store, calls, run } = setup(
    { fix: [reply], verify: [verdict("resolved")] },
    {
      seed: (store) => {
        seedFinding(store);
        store.threads[0].comments.push({ id: 3, author: "kurt", body: "Why?", createdAt: "" });
      },
    },
  );
  const outcome = await run();
  assert.deepEqual([calls.fix, calls.verify], [1, 1]);
  assert.match(store.threads[0].comments.at(-2)?.body ?? "", /can't overflow/);
  assert.equal(outcome.resolved, 1);
});

test("with only autoreview, a person's reply makes our finding the author's", async () => {
  const { store, calls, run } = setup(
    {},
    {
      seed: (store) => {
        store.pr.labels = ["autoreview"];
        seedFinding(store);
        store.threads[0].comments.push({ id: 3, author: "kurt", body: "Later.", createdAt: "" });
        seedThread(store, [fromPerson]);
      },
    },
  );
  const outcome = await run();
  assert.equal(calls.fix, 0);
  assert.equal(outcome.deferred, 1);
  assert.doesNotMatch(store.comments.at(-1)?.body ?? "", /Should this clamp/);
});

test("a deferred thread the author answers goes back to the fixer", async () => {
  const deferred = compose("x", "Your call.", { role: "fixer", kind: "answer", deferred: true });
  const { calls, run } = setup(
    { fix: [reply], verify: [verdict("resolved")] },
    {
      seed: (store) => {
        seedFinding(store);
        const { comments } = store.threads[0];
        comments.push({ id: 3, author: "fixer-bot", body: deferred, createdAt: "" });
        comments.push({ id: 4, author: "kurt", body: "Keep it as is.", createdAt: "" });
      },
    },
  );
  await run();
  assert.equal(calls.fix, 1);
});

test("a finding on a line someone else commented on is still posted inline", async () => {
  const { store, run } = setup(
    {
      review: [{ summary: "One problem.", findings: [finding] }],
      fix: [reply],
      verify: [verdict("resolved")],
    },
    seeded(["autoreview", "autofix"], [fromPerson]),
  );
  await run();
  const markers = store.threads.flatMap((t) => t.comments.map((c) => readMarker(c.body)));
  assert.ok(markers.some((marker) => marker?.kind === "finding"));
  assert.doesNotMatch(store.comments[0]?.body ?? "", /Outside the diff/);
});

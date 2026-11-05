import assert from "node:assert/strict";
import { test } from "node:test";
import { Gitea } from "../src/gitea.ts";

/** A recorded request, and a stub server answering by method and path. */
interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Routes = Record<string, unknown>;

function stub(routes: Routes): { forge: Gitea; calls: Call[] } {
  const calls: Call[] = [];

  // Answer each request from the route table, keyed "METHOD /path"
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace("/api/v1", "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return new Response("not found", { status: 404 });
    }
    const value = routes[key];
    return new Response(typeof value === "string" ? value : JSON.stringify(value ?? {}), {
      status: 200,
    });
  };
  const forge = new Gitea({
    url: "https://g.example",
    owner: "o",
    repo: "r",
    token: "t",
    fetch: fake as typeof fetch,
  });
  return { forge, calls };
}

const user = (login: string) => ({ login });

test("a pull request is read, with WIP titles counted as drafts", async () => {
  const { forge } = stub({
    "GET /repos/o/r/pulls/7": {
      number: 7,
      title: "WIP: Grow ferns",
      body: null,
      user: user("kurt"),
      state: "open",
      labels: [{ name: "autoreview" }],
      head: { ref: "ferns", sha: "abc", label: "ferns", repo_id: 1 },
      base: { ref: "main", sha: "def", repo_id: 1 },
    },
  });
  const pr = await forge.pullRequest(7);
  assert.equal(pr.draft, true);
  assert.equal(pr.body, "");
  assert.deepEqual(pr.labels, ["autoreview"]);
  assert.equal(pr.headSha, "abc");
  assert.equal(pr.headBranch, "ferns");
});

test("a deleted head branch, or one in a fork, can't take pushes", async () => {
  const pull = (head: object) => ({
    number: 7,
    title: "Grow ferns",
    body: "",
    user: user("kurt"),
    state: "open",
    labels: [],
    head: { sha: "abc", ...head },
    base: { ref: "main", sha: "def", repo_id: 1 },
  });
  const { forge } = stub({
    "GET /repos/o/r/pulls/7": pull({ ref: "refs/pull/7/head", label: "ferns", repo_id: 1 }),
    "GET /repos/o/r/pulls/8": pull({ ref: "ferns", label: "someone:ferns", repo_id: 2 }),
  });
  const deleted = await forge.pullRequest(7);
  assert.deepEqual([deleted.headRef, deleted.headBranch], ["ferns", undefined]);
  assert.equal((await forge.pullRequest(8)).headBranch, undefined);
});

test("review comments group into threads by path and line, oldest first", async () => {
  const comment = (id: number, at: string, extra: object) => ({
    id,
    body: `c${id}`,
    user: user("bot"),
    path: "a.ts",
    position: 3,
    original_position: 0,
    resolver: null,
    created_at: at,
    ...extra,
  });
  const { forge } = stub({
    "GET /repos/o/r/pulls/7/reviews": [
      { id: 1, state: "COMMENT" },
      { id: 2, state: "COMMENT" },
      { id: 3, state: "PENDING" },
    ],
    "GET /repos/o/r/pulls/7/reviews/1/comments": [
      comment(10, "2026-01-01T00:00:00Z", { resolver: user("bot") }),
      comment(11, "2026-01-01T00:00:01Z", { path: "b.ts", position: 0, original_position: 9 }),
    ],
    "GET /repos/o/r/pulls/7/reviews/2/comments": [
      comment(12, "2026-01-01T00:00:02Z", { user: user("kurt") }),
    ],
  });
  const threads = await forge.threads(7);

  // Two threads: a.ts line 3 (resolved, with a reply), and b.ts old line 9
  assert.deepEqual(
    threads.map((t) => [t.key, t.resolved, t.comments.map((c) => c.id)]),
    [
      ["a.ts:+3", true, [10, 12]],
      ["b.ts:-9", false, [11]],
    ],
  );
  assert.equal(threads[1].side, "old");
});

test("writes go to the right endpoints with the right bodies", async () => {
  const { forge, calls } = stub({
    "POST /repos/o/r/pulls/7/reviews": {},
    "POST /repos/o/r/pulls/7/comments/10/replies": {},
    "POST /repos/o/r/pulls/comments/10/resolve": {},
    "GET /repos/o/r/labels": [{ id: 5, name: "needs-author" }],
    "POST /repos/o/r/issues/7/labels": [],
    "DELETE /repos/o/r/issues/7/labels/5": "",
  });
  const thread = {
    key: "a.ts:+3",
    path: "a.ts",
    line: 3,
    side: "new" as const,
    resolved: false,
    comments: [],
  };
  const opened = { ...thread, comments: [{ id: 10, author: "bot", body: "", createdAt: "" }] };

  // Post a review, reply, resolve, and add and remove a label
  await forge.review(7, {
    body: "summary",
    commit: "abc",
    comments: [{ path: "a.ts", line: 3, body: "hm" }],
  });
  await forge.reply(7, opened, "fixed");
  await forge.resolve(opened);
  await forge.addLabel(7, "needs-author");
  await forge.removeLabel(7, "needs-author");
  assert.deepEqual(calls[0].body, {
    body: "summary",
    event: "COMMENT",
    commit_id: "abc",
    comments: [{ path: "a.ts", new_position: 3, body: "hm" }],
  });
  assert.deepEqual(calls[1].body, { body: "fixed" });
  assert.deepEqual(calls[4].body, { labels: [5] });
  assert.equal(calls.filter((c) => c.path === "/repos/o/r/labels").length, 1);
});

test("errors carry the server's message", async () => {
  const { forge } = stub({});
  await assert.rejects(forge.login(), /Gitea GET \/user: 404 not found/);
});

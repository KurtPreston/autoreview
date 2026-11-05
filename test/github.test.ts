import assert from "node:assert/strict";
import { test } from "node:test";
import { ACTIONS_BOT, GitHub } from "../src/github.ts";

/** A recorded request, and a stub server answering by method and path. */
interface Call {
  method: string;
  path: string;
  accept: string;
  body: Record<string, unknown> | undefined;
}
type Answer = unknown | ((call: Call) => unknown);
/** A route's value, or a `Response` to send as is. */
type Routes = Record<string, Answer>;

const API = "https://api.example";

function stub(routes: Routes): { forge: GitHub; calls: Call[] } {
  const calls: Call[] = [];

  // Answer each request from the route table, keyed "METHOD /path"; GraphQL is "POST graphql"
  const fake = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname === "/graphql" ? "graphql" : url.pathname + url.search;
    const method = init?.method ?? "GET";
    const headers = init?.headers as Record<string, string>;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path, accept: headers.Accept, body };
    calls.push(call);
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return new Response("not found", { status: 404 });
    }
    const route = routes[key];
    const value = typeof route === "function" ? route(call) : route;
    if (value instanceof Response) {
      return value;
    }
    return new Response(typeof value === "string" ? value : JSON.stringify(value ?? {}));
  };
  const forge = new GitHub({
    api: API,
    graphql: `${API}/graphql`,
    owner: "o",
    repo: "r",
    token: "t",
    fetch: fake as typeof fetch,
  });
  return { forge, calls };
}

const pull = (head: object) => ({
  number: 7,
  title: "Grow ferns",
  body: null,
  user: { login: "kurt" },
  draft: false,
  state: "open",
  labels: [{ name: "autoreview" }],
  head: { ref: "ferns", sha: "abc", ...head },
  base: { ref: "main", sha: "def", repo: { full_name: "o/r" } },
});

test("a pull request is read; heads from forks or deleted repositories can't take fixes", async () => {
  const { forge } = stub({
    "GET /repos/o/r/pulls/7": pull({ repo: { full_name: "o/r" } }),
    "GET /repos/o/r/pulls/8": pull({ repo: { full_name: "someone/r" } }),
    "GET /repos/o/r/pulls/9": pull({ repo: null }),
  });
  const pr = await forge.pullRequest(7);
  assert.equal(pr.body, "");
  assert.deepEqual(pr.labels, ["autoreview"]);
  assert.deepEqual([pr.headRef, pr.headBranch, pr.headSha], ["ferns", "ferns", "abc"]);
  assert.equal((await forge.pullRequest(8)).headBranch, undefined);
  assert.equal((await forge.pullRequest(9)).headBranch, undefined);
});

test("the diff is asked for in diff format", async () => {
  const { forge, calls } = stub({ "GET /repos/o/r/pulls/7": "diff --git a/x b/x\n" });
  assert.equal(await forge.diff(7), "diff --git a/x b/x\n");
  assert.equal(calls[0].accept, "application/vnd.github.diff");
});

test("the workflow token, which has no user, posts as the Actions bot", async () => {
  const forbidden = stub({ "GET /user": new Response("no", { status: 403 }) });
  assert.equal(await forbidden.forge.login(), ACTIONS_BOT);
  const person = stub({ "GET /user": { login: "kurt" } });
  assert.equal(await person.forge.login(), "kurt");
});

test("threads come from GraphQL pages, oldest first, with outdated lines kept", async () => {
  // Two pages: an outdated thread, then two on one line and an empty one
  const comment = (id: number, at: string, login = "bot") => ({
    databaseId: id,
    body: `c${id}`,
    createdAt: at,
    author: { login },
  });
  const thread = (id: string, extra: object) => ({
    id,
    isResolved: false,
    path: "a.ts",
    line: 3,
    originalLine: 3,
    diffSide: "RIGHT",
    ...extra,
  });
  const pages = [
    {
      pageInfo: { hasNextPage: true, endCursor: "c1" },
      nodes: [
        thread("T1", {
          line: null,
          originalLine: 9,
          isResolved: true,
          comments: { nodes: [comment(10, "2026-01-01T00:00:02Z")] },
        }),
      ],
    },
    {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        thread("T2", { comments: { nodes: [comment(11, "2026-01-01T00:00:00Z")] } }),
        thread("T3", {
          comments: {
            nodes: [comment(12, "2026-01-01T00:00:01Z"), comment(13, "x", "kurt")],
          },
        }),
        thread("T4", { diffSide: "LEFT", comments: { nodes: [] } }),
      ],
    },
  ];
  const { forge, calls } = stub({
    "POST graphql": (call: Call) => {
      const variables = call.body?.variables as { cursor: string | null };
      const page = variables.cursor === null ? pages[0] : pages[1];
      return { data: { repository: { pullRequest: { reviewThreads: page } } } };
    },
  });
  const threads = await forge.threads(7);
  assert.deepEqual(
    threads.map((t) => [t.id, t.key, t.line, t.resolved, t.comments.map((c) => c.id)]),
    [
      ["T2", "a.ts:+3", 3, false, [11]],
      ["T3", "a.ts:+3#2", 3, false, [12, 13]],
      ["T1", "a.ts:+9", 9, true, [10]],
    ],
  );
  assert.equal(threads[1].comments[1].author, "kurt");
  assert.deepEqual(
    calls.map((c) => (c.body?.variables as { number: number } | undefined)?.number),
    [7, 7],
  );
});

test("writes go to the right endpoints with the right bodies", async () => {
  const { forge, calls } = stub({
    "POST /repos/o/r/pulls/7/reviews": {},
    "POST /repos/o/r/pulls/7/comments/10/replies": {},
    "POST graphql": { data: { resolveReviewThread: { thread: { id: "T1" } } } },
    "POST /repos/o/r/issues/7/comments": {},
    "POST /repos/o/r/labels": {},
    "POST /repos/o/r/issues/7/labels": [],
    "DELETE /repos/o/r/issues/7/labels/needs-author": "",
  });
  const thread = {
    id: "T1",
    key: "a.ts:+3",
    path: "a.ts",
    line: 3,
    side: "new" as const,
    resolved: false,
    comments: [{ id: 10, author: "bot", body: "", createdAt: "" }],
  };

  // Post a review, reply, resolve, comment, and add and remove a label
  await forge.review(7, {
    body: "summary",
    commit: "abc",
    comments: [{ path: "a.ts", line: 3, body: "hm" }],
  });
  await forge.reply(7, thread, "fixed");
  await forge.resolve(thread);
  await forge.comment(7, "done");
  await forge.addLabel(7, "needs-author");
  await forge.addLabel(7, "needs-author");
  await forge.removeLabel(7, "needs-author");
  await forge.removeLabel(7, "gone");
  assert.deepEqual(calls[0].body, {
    body: "summary",
    event: "COMMENT",
    commit_id: "abc",
    comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "hm" }],
  });
  assert.deepEqual(calls[1].body, { body: "fixed" });
  assert.deepEqual(calls[2].body?.variables, { thread: "T1" });
  assert.match(String(calls[2].body?.query), /resolveReviewThread/);

  // The missing label is created once, then added by name
  assert.equal(calls.filter((c) => c.path === "/repos/o/r/labels/needs-author").length, 1);
  assert.deepEqual(calls.find((c) => c.path === "/repos/o/r/labels")?.body, {
    name: "needs-author",
    color: "c5def5",
  });
  assert.deepEqual(calls.at(-3)?.body, { labels: ["needs-author"] });
});

test("errors carry the server's message, and GraphQL errors throw", async () => {
  const { forge } = stub({
    "POST graphql": { errors: [{ message: "Could not resolve to a PullRequest" }] },
  });
  await assert.rejects(forge.pullRequest(1), /GitHub GET \/repos\/o\/r\/pulls\/1: 404 not found/);
  await assert.rejects(forge.threads(1), /GitHub graphql: Could not resolve to a PullRequest/);
});

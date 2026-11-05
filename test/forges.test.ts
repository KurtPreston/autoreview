import assert from "node:assert/strict";
import { test } from "node:test";
import { forgeKind, forges, githubApi } from "../src/forges.ts";
import { Gitea } from "../src/gitea.ts";
import { GitHub } from "../src/github.ts";

const github = { url: "https://github.com", owner: "o", repo: "r" };
const gitea = { url: "https://git.example", owner: "o", repo: "r" };
const noGh = () => undefined;

test("the forge follows the CI, then the host, unless overridden", () => {
  assert.equal(forgeKind(github, {}), "github");
  assert.equal(forgeKind({ ...github, url: "https://acme.ghe.com" }, {}), "github");
  assert.equal(forgeKind(gitea, {}), "gitea");

  // Gitea Actions sets GITHUB_ACTIONS as well as its own flag
  assert.equal(forgeKind(gitea, { GITHUB_ACTIONS: "true" }), "github");
  assert.equal(forgeKind(gitea, { GITHUB_ACTIONS: "true", GITEA_ACTIONS: "true" }), "gitea");
  assert.equal(forgeKind(github, { AUTOREVIEW_FORGE: "gitea" }), "gitea");
});

test("GitHub's API roots come from Actions, or from the web root", () => {
  assert.deepEqual(githubApi(github, {}), {
    api: "https://api.github.com",
    graphql: "https://api.github.com/graphql",
  });
  assert.deepEqual(githubApi({ ...github, url: "https://ghe.acme" }, {}), {
    api: "https://ghe.acme/api/v3",
    graphql: "https://ghe.acme/api/graphql",
  });
  const env = { GITHUB_API_URL: "https://x/api", GITHUB_GRAPHQL_URL: "https://x/gql" };
  assert.deepEqual(githubApi(github, env), { api: "https://x/api", graphql: "https://x/gql" });
});

test("on GitHub one token posts as both roles: the workflow's, then gh's", async () => {
  // The workflow token wins over gh's login
  const fromEnv = await forges(github, { env: { GITHUB_TOKEN: "w" }, ghToken: () => "g" });
  assert.ok(fromEnv.reviewer instanceof GitHub);
  assert.equal(fromEnv.reviewer, fromEnv.implementer);
  assert.equal(fromEnv.reviewer.options.token, "w");
  assert.equal(fromEnv.reviewer.options.api, "https://api.github.com");

  // gh is asked about the remote's host
  let asked = "";
  const ghToken = (host: string) => ((asked = host), "g");
  const fromGh = await forges(github, { env: {}, ghToken });
  assert.equal((fromGh.reviewer as GitHub).options.token, "g");
  assert.equal(asked, "github.com");
  await assert.rejects(forges(github, { env: {}, ghToken: noGh }), /log in with gh/);
});

test("two role tokens give two identities, on either forge", async () => {
  const env = { AUTOREVIEW_REVIEWER_TOKEN: "a", AUTOREVIEW_IMPLEMENTER_TOKEN: "b" };
  const onGitHub = await forges(github, { env, ghToken: noGh });
  assert.equal((onGitHub.reviewer as GitHub).options.token, "a");
  assert.equal((onGitHub.implementer as GitHub).options.token, "b");
  const onGitea = await forges(gitea, { env, ghToken: noGh });
  assert.ok(onGitea.reviewer instanceof Gitea);
  assert.equal((onGitea.implementer as Gitea).options.token, "b");
});

test("on Gitea one GITEA_TOKEN posts as both roles", async () => {
  const roles = await forges(gitea, { env: { GITEA_TOKEN: "t", GITHUB_TOKEN: "w" } });
  assert.ok(roles.reviewer instanceof Gitea);
  assert.equal(roles.reviewer.options.token, "t");
  assert.equal(roles.reviewer, roles.implementer);
});

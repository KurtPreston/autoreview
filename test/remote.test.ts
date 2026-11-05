import assert from "node:assert/strict";
import { test } from "node:test";
import { findToken, parseRemote, teaToken } from "../src/remote.ts";

test("remotes of every form name the web server and repository", () => {
  const want = { url: "https://gitea.example", owner: "octo", repo: "example" };
  assert.deepEqual(parseRemote("ssh://git@gitea.example:2222/octo/example.git"), want);
  assert.deepEqual(parseRemote("git@gitea.example:octo/example.git"), want);
  assert.deepEqual(parseRemote("https://gitea.example/octo/example.git"), want);
  assert.deepEqual(parseRemote("http://localhost:3000/octo/example"), {
    ...want,
    url: "http://localhost:3000",
  });
});

test("tea's config yields the token of the matching login", () => {
  const yaml = [
    "logins:",
    "    - name: other",
    "      url: https://other.example",
    "      token: wrong",
    "    - name: gitea",
    "      url: https://gitea.example/",
    "      token: right",
    "      user: kurt",
    "preferences:",
    "    editor: false",
  ].join("\n");
  assert.equal(teaToken(yaml, "https://gitea.example"), "right");
  assert.equal(teaToken(yaml, "https://missing.example"), undefined);
});

test("GITEA_TOKEN wins over tea", async () => {
  assert.equal(await findToken("https://gitea.example", { GITEA_TOKEN: "env" }), "env");
});

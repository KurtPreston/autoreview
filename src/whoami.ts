#!/usr/bin/env -S node --use-system-ca
// Print who setup-git.sh should push and commit as: the user for origin's URL, the commit
// name and the commit email, one per line. Reads PUSH_TOKEN, GITHUB_SERVER_URL,
// GITHUB_REPOSITORY, and the CI's variables that tell GitHub from Gitea.
import { forgeKind, githubApi } from "./forges.ts";
import { ACTIONS_BOT } from "./github.ts";

interface Identity {
  user: string;
  name: string;
  email: string;
}

// The repository and token the job pushes with
const env = process.env;
const server = (env.GITHUB_SERVER_URL ?? "").replace(/\/$/, "");
const [owner = "", repo = ""] = (env.GITHUB_REPOSITORY ?? "").split("/");
const remote = { url: server, owner, repo };
const token = env.PUSH_TOKEN ?? "";
const host = new URL(server).host;

const identity = forgeKind(remote, env) === "github" ? await github() : await gitea();
console.log([identity.user, identity.name, identity.email].join("\n"));

/**
 * On GitHub, a personal token commits as its user; the workflow's own token has no user,
 * so it commits as the Actions bot. Either pushes with the token as the password.
 */
async function github(): Promise<Identity> {
  const response = await fetch(`${githubApi(remote, env).api}/user`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (response.ok) {
    const user = (await response.json()) as { login: string; id: number };
    const email = `${user.id}+${user.login}@users.noreply.${host}`;
    return { user: "x-access-token", name: user.login, email };
  }
  const email = `41898282+${ACTIONS_BOT}@users.noreply.${host}`;
  return { user: "x-access-token", name: ACTIONS_BOT, email };
}

/** On Gitea, the token's user, with the server's no-reply address; a generic name if unknown. */
async function gitea(): Promise<Identity> {
  let login = "autoreview";
  try {
    const response = await fetch(`${server}/api/v1/user`, {
      headers: { Authorization: `token ${token}` },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    login = ((await response.json()) as { login: string }).login;
  } catch (error) {
    // Network errors keep their reason (a certificate, say) in the cause
    const reason = (error as { cause?: Error }).cause?.message ?? (error as Error).message;
    console.error(
      `autoreview: couldn't look up the token's user at ${server}/api/v1/user (${reason}); ` +
        "committing as autoreview (a bot token needs the read:user scope)",
    );
  }
  return { user: login, name: login, email: `${login}@noreply.${host}` };
}

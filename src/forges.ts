// Choose the forge a repository lives on, and the tokens each role posts with.
import { execFileSync } from "node:child_process";
import type { Forge } from "./forge.ts";
import { Gitea } from "./gitea.ts";
import { GitHub } from "./github.ts";
import { findToken, type Remote } from "./remote.ts";

export type ForgeKind = "github" | "gitea";

/** The forge for each role; the same one when both post as one identity. */
export interface Roles {
  reviewer: Forge;
  fixer: Forge;
}

/** Hooks for tests: the environment, and how to ask gh for its token. */
export interface Lookup {
  env?: NodeJS.ProcessEnv;
  ghToken?: (host: string) => string | undefined;
}

/**
 * Which forge serves a remote. Gitea Actions also sets `GITHUB_ACTIONS`, so its
 * own flag wins; outside CI, github.com and GHE.com are GitHub and the rest Gitea.
 */
export function forgeKind(remote: Remote, env: NodeJS.ProcessEnv = process.env): ForgeKind {
  if (env.AUTOREVIEW_FORGE === "github" || env.AUTOREVIEW_FORGE === "gitea") {
    return env.AUTOREVIEW_FORGE;
  }
  if (env.GITEA_ACTIONS === "true") {
    return "gitea";
  }
  if (env.GITHUB_ACTIONS === "true") {
    return "github";
  }
  const host = new URL(remote.url).hostname;
  return host === "github.com" || host.endsWith(".ghe.com") ? "github" : "gitea";
}

/** GitHub's REST and GraphQL roots: from Actions, or derived from the web root. */
export function githubApi(
  remote: Remote,
  env: NodeJS.ProcessEnv = process.env,
): { api: string; graphql: string } {
  if (env.GITHUB_API_URL && env.GITHUB_GRAPHQL_URL) {
    return { api: env.GITHUB_API_URL, graphql: env.GITHUB_GRAPHQL_URL };
  }

  // github.com and GHE.com serve the API on an api. host; Enterprise Server under /api
  const url = new URL(remote.url);
  if (url.hostname === "github.com" || url.hostname.endsWith(".ghe.com")) {
    const api = `${url.protocol}//api.${url.host}`;
    return { api, graphql: `${api}/graphql` };
  }
  return { api: `${remote.url}/api/v3`, graphql: `${remote.url}/api/graphql` };
}

/** One forge per role when both role tokens are set, otherwise one shared identity. */
export async function forges(remote: Remote, lookup: Lookup = {}): Promise<Roles> {
  const env = lookup.env ?? process.env;
  const kind = forgeKind(remote, env);
  const make = (token: string): Forge =>
    kind === "github"
      ? new GitHub({ ...githubApi(remote, env), owner: remote.owner, repo: remote.repo, token })
      : new Gitea({ ...remote, token });

  // Separate identities, when the workflow has a bot for each role
  const { AUTOREVIEW_REVIEWER_TOKEN: reviewer, AUTOREVIEW_FIXER_TOKEN: fixer } = env;
  if (reviewer && fixer) {
    return { reviewer: make(reviewer), fixer: make(fixer) };
  }

  // Otherwise both roles post as whoever the one token belongs to
  const token =
    kind === "github"
      ? githubToken(remote, { env, ghToken: lookup.ghToken ?? ghAuthToken })
      : await findToken(remote.url, env);
  if (!token) {
    const hint =
      kind === "github"
        ? "GITHUB_TOKEN or GH_TOKEN, or log in with gh"
        : "GITEA_TOKEN, or log in with tea";
    throw new Error(`no token for ${remote.url}: set the AUTOREVIEW_* tokens or ${hint}`);
  }
  const shared = make(token);
  return { reviewer: shared, fixer: shared };
}

/** A GitHub token: the workflow's or one in the environment, else gh's login. */
export function githubToken(remote: Remote, lookup: Required<Lookup>): string | undefined {
  const { env, ghToken } = lookup;
  return env.GITHUB_TOKEN || env.GH_TOKEN || ghToken(new URL(remote.url).host);
}

/** gh's token for a host, or nothing when gh is missing or logged out. */
export function ghAuthToken(host: string): string | undefined {
  try {
    const token = execFileSync("gh", ["auth", "token", "--hostname", host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

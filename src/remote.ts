import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A repository on a forge: the server's web root, and owner/name. */
export interface Remote {
  url: string;
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL into the server's web root and the repository.
 * Accepts `https://host/owner/repo.git`, `ssh://git@host:2222/owner/repo.git`
 * and `git@host:owner/repo.git`. SSH remotes are assumed to serve the web on https.
 */
export function parseRemote(remote: string): Remote {
  // The scp-like form has no scheme: user@host:owner/repo
  const scp = /^[\w.-]+@([^:/]+):([^/]+)\/(.+?)(\.git)?\/?$/.exec(remote);
  if (scp) {
    return { url: `https://${scp[1]}`, owner: scp[2], repo: scp[3] };
  }

  // Anything else is a URL; ssh drops its port, since the web runs elsewhere
  const parsed = new URL(remote);
  const [owner, repo] = parsed.pathname
    .replace(/^\//, "")
    .replace(/\.git\/?$/, "")
    .split("/");
  if (!owner || !repo) {
    throw new Error(`can't find owner/repo in remote ${remote}`);
  }
  const web =
    parsed.protocol === "ssh:"
      ? `https://${parsed.hostname}`
      : `${parsed.protocol}//${parsed.host}`;
  return { url: web, owner, repo };
}

/** Find a token for a server: an explicit variable first, then tea's saved logins. */
export async function findToken(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (env.GITEA_TOKEN) {
    return env.GITEA_TOKEN;
  }

  // tea keeps its config in the platform's config directory
  const paths = [
    join(homedir(), "Library", "Application Support", "tea", "config.yml"),
    join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "tea", "config.yml"),
  ];
  for (const path of paths) {
    try {
      return teaToken(await readFile(path, "utf8"), url);
    } catch {
      // Try the next location
    }
  }
  return undefined;
}

/** Pick the token of the tea login whose url matches, from tea's config.yml. */
export function teaToken(yaml: string, url: string): string | undefined {
  // Logins are list items; read each one's url and token
  const want = url.replace(/\/$/, "");
  for (const block of yaml.split(/\n\s*-\s+(?=\w+:)/)) {
    const field = (name: string) =>
      new RegExp(`^\\s*${name}:\\s*"?([^"\\n]+)"?`, "m").exec(block)?.[1].trim();
    if (field("url")?.replace(/\/$/, "") === want) {
      return field("token");
    }
  }
  return undefined;
}

#!/usr/bin/env -S node --use-system-ca
// Print the login a Gitea token belongs to, for setup-git.sh to name commits after.
// Usage: whoami.ts <server url>, with the token in PUSH_TOKEN. Explains on stderr and exits 1 on failure.
const server = (process.argv[2] ?? "").replace(/\/$/, "");
try {
  const response = await fetch(`${server}/api/v1/user`, {
    headers: { Authorization: `token ${process.env.PUSH_TOKEN ?? ""}` },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  console.log(((await response.json()) as { login: string }).login);
} catch (error) {
  // Network errors keep their reason (a certificate, say) in the cause
  const reason = (error as { cause?: Error }).cause?.message ?? (error as Error).message;
  console.error(
    `autoreview: couldn't look up the token's user at ${server}/api/v1/user (${reason})`,
  );
  process.exit(1);
}

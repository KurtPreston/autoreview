#!/usr/bin/env bash
# Prepare the job's checkout for autoreview: fetch and push as the posting identity.
# Swaps actions/checkout's auth header for a token in origin's URL, and names commits after
# the token's user (looked up by src/whoami.ts). Reads PUSH_TOKEN, GITHUB_SERVER_URL,
# GITHUB_REPOSITORY and GITHUB_WORKSPACE.
set -euo pipefail

cd "$GITHUB_WORKSPACE"
server="${GITHUB_SERVER_URL%/}"

# Ask the server who the token belongs to, through Node, which trusts the same certificates
# as the tool; the built-in Actions token has no user, and gets a generic name
if ! login="$(node --use-system-ca "$(dirname "${BASH_SOURCE[0]}")/src/whoami.ts" "$server")"; then
  echo "autoreview: committing as autoreview (a bot token needs the read:user scope)" >&2
  login=autoreview
fi
host="${server#*://}"

# actions/checkout authenticates with a header, which would override the URL's token
git config --local --unset-all "http.$server/.extraheader" || true
git remote set-url origin "${server%%://*}://$login:$PUSH_TOKEN@$host/$GITHUB_REPOSITORY.git"

# Commits carry the poster's name, with the server's no-reply address
git config --local user.name "$login"
git config --local user.email "$login@noreply.$host"
echo "autoreview: git fetches, pushes and commits as $login"

#!/usr/bin/env bash
# Prepare the job's checkout for autoreview: fetch and push as the posting identity.
# Swaps actions/checkout's auth header for a token in origin's URL, and names commits after
# the token's user, or the Actions bot for GitHub's built-in token (looked up by
# src/whoami.ts). Reads PUSH_TOKEN, GITHUB_SERVER_URL, GITHUB_REPOSITORY and GITHUB_WORKSPACE.
set -euo pipefail

cd "$GITHUB_WORKSPACE"
server="${GITHUB_SERVER_URL%/}"
host="${server#*://}"

# Ask the server who the token belongs to, through Node, which trusts the same certificates
# as the tool
identity="$(node --use-system-ca "$(dirname "${BASH_SOURCE[0]}")/src/whoami.ts")"
{ read -r user; read -r name; read -r email; } <<< "$identity"

# actions/checkout authenticates with a header, which would override the URL's token
git config --local --unset-all "http.$server/.extraheader" || true
git remote set-url origin "${server%%://*}://$user:$PUSH_TOKEN@$host/$GITHUB_REPOSITORY.git"

# Commits carry the poster's name and no-reply address
git config --local user.name "$name"
git config --local user.email "$email"
echo "autoreview: git fetches, pushes and commits as $name"

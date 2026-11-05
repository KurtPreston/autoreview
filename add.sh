#!/usr/bin/env bash
# Enable autoreview on a Gitea repository: see `add.sh --help`.
# A thin wrapper so the tool can be run from anywhere; the work happens in src/add.ts.
set -euo pipefail
exec node --use-system-ca "$(dirname "${BASH_SOURCE[0]}")/src/add.ts" "$@"

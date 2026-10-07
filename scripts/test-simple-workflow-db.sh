#!/usr/bin/env bash
# Run the shared no-network PostgreSQL suite, including standard workflow and
# device-lease regressions as well as the simple queue contention checks.
set -euo pipefail
exec bash "$(dirname "$0")/test-room-away-db.sh" "$@"

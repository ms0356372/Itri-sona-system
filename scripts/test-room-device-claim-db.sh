#!/usr/bin/env bash
# Full migration chain, room device leases, permission/room/count regressions,
# and real contention tests, in a disposable PostgreSQL container with no network.
set -euo pipefail
exec bash "$(dirname "$0")/test-room-away-db.sh" "$@"

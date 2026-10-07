#!/usr/bin/env bash
# The shared disposable PostgreSQL runner applies every production migration,
# verifies legacy-account backfill, exercises page-permission RLS and RPCs, then
# runs room/count regressions and all six independent-connection races.
set -euo pipefail
exec bash "$(dirname "$0")/test-room-away-db.sh" "$@"

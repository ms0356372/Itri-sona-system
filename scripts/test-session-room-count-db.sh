#!/usr/bin/env bash
# The shared disposable-database runner verifies both features and their races.
set -euo pipefail
exec bash "$(dirname "$0")/test-room-away-db.sh"

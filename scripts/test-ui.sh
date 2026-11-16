#!/usr/bin/env bash
# Backwards-compatible alias for scripts/test-e2e.sh
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/test-e2e.sh" "$@"

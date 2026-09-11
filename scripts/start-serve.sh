#!/bin/bash
# Kill any existing serve processes before starting new one
# Prevents zombie process accumulation when launchd restarts
/usr/sbin/lsof -ti:3210 | xargs kill 2>/dev/null
sleep 1
# Force kill stragglers
/usr/sbin/lsof -ti:3210 | xargs kill -9 2>/dev/null
cd /Users/zachstock/GitHub/prime
# launchd stderr has no timestamps, so an old crash block at the tail of
# serve-error.log is indistinguishable from a current one. Anchor each start.
echo "=== serve start $(date '+%Y-%m-%d %H:%M:%S %Z') ===" >&2
exec npx tsx src/index.ts serve --port 3210 --no-sync

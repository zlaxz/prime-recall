#!/bin/bash
# Kill any existing shift processes before starting new one
pkill -f "index.ts shift" 2>/dev/null
sleep 1
pkill -9 -f "index.ts shift" 2>/dev/null
cd /Users/zachstock/GitHub/prime
export NODE_OPTIONS="--max-old-space-size=8192"
# launchd stderr has no timestamps, so an old crash block at the tail of
# shift-error.log is indistinguishable from a current one. Anchor each start.
echo "=== shift start $(date '+%Y-%m-%d %H:%M:%S %Z') ===" >&2
exec npx tsx src/index.ts shift

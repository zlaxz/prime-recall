#!/bin/bash
# Kill any existing serve processes before starting new one
# Prevents zombie process accumulation when launchd restarts
/usr/sbin/lsof -ti:3210 | xargs kill 2>/dev/null
sleep 1
# Force kill stragglers
/usr/sbin/lsof -ti:3210 | xargs kill -9 2>/dev/null
cd /Users/zachstock/GitHub/prime
exec npx tsx src/index.ts serve --port 3210 --no-sync

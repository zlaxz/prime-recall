#!/bin/bash
# Kill any existing shift processes before starting new one
pkill -f "index.ts shift" 2>/dev/null
sleep 1
pkill -9 -f "index.ts shift" 2>/dev/null
cd /Users/zachstock/GitHub/prime
export NODE_OPTIONS="--max-old-space-size=8192"
exec npx tsx src/index.ts shift

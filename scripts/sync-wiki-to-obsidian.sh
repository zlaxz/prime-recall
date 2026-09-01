#!/bin/bash
# Prime → laptop mirror (ONE target). Runs via com.prime.obsidian-sync launchd
# agent every 15 min.
#
# Simplified 2026-08-31: previously mirrored the same wikis into the Obsidian
# vault AND Claude Desktop's file space on two rsync legs. Now everything lands
# in Claude Desktop's folder (Cowork reads it natively) and the Obsidian vault
# path is a symlink to it. One copy, one sync, one place.

MACMINI="macmini"
PRIME_DIR="/Users/zstoc/Documents/Claude/Prime"

mkdir -p "${PRIME_DIR}/wiki" "${PRIME_DIR}/cycles"

# Command Center (TODAY.md / LEDGER.md — regenerated hourly on the Mini)
rsync -az "${MACMINI}:~/.prime/export/" "${PRIME_DIR}/" 2>/dev/null

# Wikis (people + projects) and Quinn's working state
rsync -az --delete "${MACMINI}:~/.prime/wiki/" "${PRIME_DIR}/wiki/" 2>/dev/null
rsync -az "${MACMINI}:~/.prime/FOCUS.md" "${PRIME_DIR}/FOCUS.md" 2>/dev/null

# Latest Quinn cycle (most recent only)
LATEST_CYCLE=$(ssh ${MACMINI} "ls -t ~/.prime/cycles/*.md 2>/dev/null | head -1")
if [ -n "$LATEST_CYCLE" ]; then
  rsync -az "${MACMINI}:${LATEST_CYCLE}" "${PRIME_DIR}/cycles/" 2>/dev/null
fi

echo "✓ Prime mirrored to ${PRIME_DIR}"

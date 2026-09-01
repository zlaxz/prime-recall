#!/bin/bash
# Prime → laptop mirror (ONE target). Runs via com.prime.obsidian-sync launchd
# agent every 15 min.
#
# Simplified 2026-08-31: previously mirrored the same wikis into the Obsidian
# vault AND Claude Desktop's file space on two rsync legs. Now everything lands
# in Claude Desktop's folder (Cowork reads it natively) and the Obsidian vault
# path is a symlink to it. One copy, one sync, one place.

MACMINI="macmini"
# Real directory lives OUTSIDE ~/Documents: launchd-spawned rsync is denied by
# macOS TCC inside Documents ("Operation not permitted", audit 2026-08-31).
# ~/Documents/Claude/Prime and ~/ObsidianVault/Projects/prime are symlinks here,
# so Cowork/Obsidian/deep links keep their Documents paths.
PRIME_DIR="/Users/zstoc/PrimeMirror"

mkdir -p "${PRIME_DIR}/wiki" "${PRIME_DIR}/cycles"

FAIL=0
run() { "$@" 2>>/tmp/prime-obsidian-sync.err || { echo "✗ failed: $*" ; FAIL=1; }; }

# Command Center (TODAY.md / LEDGER.md / deliverables — regenerated on the Mini).
# --update: never overwrite a file Zach edited more recently on the laptop
# (Cowork "review this deliverable" edits must survive the next sync).
run rsync -az --update "${MACMINI}:~/.prime/export/" "${PRIME_DIR}/"

# Wikis (people + projects) and Quinn's working state
run rsync -az --delete "${MACMINI}:~/.prime/wiki/" "${PRIME_DIR}/wiki/"
run rsync -az "${MACMINI}:~/.prime/FOCUS.md" "${PRIME_DIR}/FOCUS.md"

# Latest Quinn cycle (most recent only)
LATEST_CYCLE=$(ssh ${MACMINI} "ls -t ~/.prime/cycles/*.md 2>/dev/null | head -1")
if [ -n "$LATEST_CYCLE" ]; then
  run rsync -az "${MACMINI}:${LATEST_CYCLE}" "${PRIME_DIR}/cycles/"
fi

if [ "$FAIL" -eq 0 ]; then echo "✓ Prime mirrored to ${PRIME_DIR} ($(date '+%H:%M'))"; else echo "✗ Prime mirror INCOMPLETE ($(date '+%H:%M')) — see /tmp/prime-obsidian-sync.err"; exit 1; fi

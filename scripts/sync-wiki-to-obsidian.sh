#!/bin/bash
# Sync Prime wiki markdown files from Mac Mini to Obsidian vault on laptop
# Run manually or add to crontab: */15 * * * * bash ~/GitHub/prime/scripts/sync-wiki-to-obsidian.sh

OBSIDIAN_VAULT="/Users/zstoc/ObsidianVault"
WIKI_DIR="${OBSIDIAN_VAULT}/Projects/prime/wiki"
MACMINI="macmini"

# Create destination dirs
mkdir -p "${WIKI_DIR}/people"
mkdir -p "${WIKI_DIR}/projects"

# Rsync wiki from Mac Mini
rsync -az --delete "${MACMINI}:~/.prime/wiki/" "${WIKI_DIR}/" 2>/dev/null

# Also sync FOCUS.md
rsync -az "${MACMINI}:~/.prime/FOCUS.md" "${OBSIDIAN_VAULT}/Projects/prime/FOCUS.md" 2>/dev/null

# Sync latest cycle output (most recent only)
LATEST_CYCLE=$(ssh ${MACMINI} "ls -t ~/.prime/cycles/*.md 2>/dev/null | head -1")
if [ -n "$LATEST_CYCLE" ]; then
  mkdir -p "${OBSIDIAN_VAULT}/Projects/prime/cycles"
  rsync -az "${MACMINI}:${LATEST_CYCLE}" "${OBSIDIAN_VAULT}/Projects/prime/cycles/" 2>/dev/null
fi

echo "✓ Wiki synced to ${WIKI_DIR}"

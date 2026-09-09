#!/bin/bash
# Rotate Prime logs — keeps last 5 rotations, max 1MB per file
LOG_DIR="$HOME/.prime/logs"
MAX_SIZE=1048576  # 1MB

for logfile in "$LOG_DIR"/*.log; do
    [ -f "$logfile" ] || continue
    size=$(stat -f%z "$logfile" 2>/dev/null || stat -c%s "$logfile" 2>/dev/null)
    if [ "$size" -gt "$MAX_SIZE" ]; then
        # Rotate: .log.4 → .log.5, .log.3 → .log.4, etc.
        for i in 4 3 2 1; do
            [ -f "${logfile}.$i" ] && mv "${logfile}.$i" "${logfile}.$((i+1))"
        done
        # Copy-then-truncate, NOT mv: launchd holds an O_APPEND fd on each
        # daemon's StandardOut/ErrorPath and never reopens it. Renaming the
        # file leaves that fd on the renamed inode, so the daemon keeps
        # appending to the .log.1 archive (unbounded) while the fresh .log
        # stays empty until the daemon happens to restart. Truncating in
        # place keeps the inode, so the live fd keeps working.
        # Tradeoff: writes landing between the cp and the truncate are lost.
        cp "$logfile" "${logfile}.1"
        > "$logfile"  # Truncate in place — keeps the inode the daemons hold
        echo "[rotate] $(date): Rotated $(basename $logfile) ($size bytes)"
    fi
done

#!/bin/bash
# ============================================================
# Prime Self-Healing Health Monitor
#
# Runs every 5 minutes. Checks all systems. Fixes what it can.
# Only alerts Zach when something is unfixable.
#
# Checks: daemons, sync freshness, token validity, DB integrity,
#          tunnel status, disk space
# ============================================================

LOG="$HOME/.prime/logs/health.log"
PRIME_DIR="$HOME/GitHub/prime"
ALERT_FILE="$HOME/.prime/health-alert"

log() { echo "[$(date '+%H:%M')] $1" >> "$LOG"; }
alert() {
  # Only alert once per issue (dedup by message hash)
  HASH=$(echo "$1" | md5 -q)
  if [ ! -f "$ALERT_FILE.$HASH" ]; then
    touch "$ALERT_FILE.$HASH"
    # Send iMessage alert
    PHONE=$(sqlite3 ~/.prime/prime.db "SELECT value FROM config WHERE key='notify_phone_number'" 2>/dev/null | tr -d '"')
    if [ -n "$PHONE" ]; then
      osascript <<SCPT
tell application "Messages" to send "[PRIME HEALTH] $1" to buddy "$PHONE"
SCPT
    fi
    log "ALERT: $1"
  fi
}
clear_alert() {
  HASH=$(echo "$1" | md5 -q)
  rm -f "$ALERT_FILE.$HASH" 2>/dev/null
}

ISSUES=0

# ── Check daemons ──────────────────────────────────────
for DAEMON in serve sync listen tunnel; do
  if ! launchctl list 2>/dev/null | grep -q "com.prime-recall.$DAEMON"; then
    log "Daemon $DAEMON not loaded — reloading..."
    launchctl load ~/Library/LaunchAgents/com.prime-recall.$DAEMON.plist 2>/dev/null
    sleep 2
    if launchctl list 2>/dev/null | grep -q "com.prime-recall.$DAEMON"; then
      log "✓ Daemon $DAEMON recovered"
      clear_alert "$DAEMON daemon down"
    else
      alert "$DAEMON daemon won't start. Check manually."
      ISSUES=$((ISSUES + 1))
    fi
  fi
done

# ── Check serve is responding ──────────────────────────
HEALTH=$(curl -s --max-time 5 http://localhost:3210/api/health 2>/dev/null)
if echo "$HEALTH" | grep -q '"ok"'; then
  clear_alert "API server not responding"
else
  log "API not responding — restarting serve daemon..."
  launchctl unload ~/Library/LaunchAgents/com.prime-recall.serve.plist 2>/dev/null
  sleep 2
  launchctl load ~/Library/LaunchAgents/com.prime-recall.serve.plist 2>/dev/null
  sleep 5
  HEALTH2=$(curl -s --max-time 5 http://localhost:3210/api/health 2>/dev/null)
  if echo "$HEALTH2" | grep -q '"ok"'; then
    log "✓ API server recovered"
    clear_alert "API server not responding"
  else
    alert "API server won't restart. Port 3210 may be in use."
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── Check sync freshness ──────────────────────────────
check_sync() {
  local SOURCE=$1
  local MAX_HOURS=$2
  local LAST=$(sqlite3 ~/.prime/prime.db "SELECT last_sync_at FROM sync_state WHERE source='$SOURCE'" 2>/dev/null)
  if [ -z "$LAST" ]; then return; fi

  local AGE_HOURS=$(python3 -c "
from datetime import datetime, timezone
last = datetime.fromisoformat('${LAST}'.replace(' ', 'T'))
if last.tzinfo is None: last = last.replace(tzinfo=timezone.utc)
age = (datetime.now(timezone.utc) - last).total_seconds() / 3600
print(int(age))
" 2>/dev/null)

  if [ -n "$AGE_HOURS" ] && [ "$AGE_HOURS" -gt "$MAX_HOURS" ]; then
    alert "$SOURCE sync is ${AGE_HOURS}h stale (limit: ${MAX_HOURS}h). Token may be expired."
    ISSUES=$((ISSUES + 1))
  else
    clear_alert "$SOURCE sync is"
  fi
}

check_sync "gmail" 1           # Gmail should sync within 1 hour
check_sync "calendar" 1        # Calendar within 1 hour
check_sync "claude" 2          # Claude.ai within 2 hours
check_sync "cowork" 24         # Cowork within 24 hours
check_sync "otter" 72          # Otter within 3 days
check_sync "fireflies" 72      # Fireflies within 3 days

# ── Check DB integrity ─────────────────────────────────
INTEGRITY=$(sqlite3 ~/.prime/prime.db "PRAGMA integrity_check" 2>/dev/null)
if [ "$INTEGRITY" != "ok" ]; then
  alert "Database corruption detected: $INTEGRITY"
  ISSUES=$((ISSUES + 1))
else
  clear_alert "Database corruption"
fi

# ── Check disk space ───────────────────────────────────
DISK_FREE=$(df -g ~ | tail -1 | awk '{print $4}')
if [ "$DISK_FREE" -lt 5 ]; then
  alert "Low disk space: ${DISK_FREE}GB free"
  ISSUES=$((ISSUES + 1))
fi

# ── Check tunnel ───────────────────────────────────────
TUNNEL_PID=$(pgrep -f "cloudflared tunnel" 2>/dev/null)
if [ -z "$TUNNEL_PID" ]; then
  log "Tunnel not running — restarting..."
  launchctl unload ~/Library/LaunchAgents/com.prime-recall.tunnel.plist 2>/dev/null
  launchctl load ~/Library/LaunchAgents/com.prime-recall.tunnel.plist 2>/dev/null
  clear_alert "Tunnel down"
fi

# ── Check dream pipeline freshness ─────────────────────
LAST_DREAM=$(sqlite3 ~/.prime/prime.db "SELECT value FROM graph_state WHERE key='last_dream_run'" 2>/dev/null)
if [ -n "$LAST_DREAM" ]; then
  DREAM_AGE=$(python3 -c "
from datetime import datetime, timezone
last = datetime.fromisoformat('${LAST_DREAM}'.replace('\"',''))
if last.tzinfo is None: last = last.replace(tzinfo=timezone.utc)
age = (datetime.now(timezone.utc) - last).total_seconds() / 3600
print(int(age))
" 2>/dev/null)
  if [ -n "$DREAM_AGE" ] && [ "$DREAM_AGE" -gt 36 ]; then
    alert "Dream pipeline hasn't run in ${DREAM_AGE}h. Cron job may be broken."
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── Summary ────────────────────────────────────────────
if [ "$ISSUES" -eq 0 ]; then
  log "✓ All systems healthy"
fi

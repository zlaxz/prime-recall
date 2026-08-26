#!/bin/bash
# ============================================================
# Prime Self-Healing Health Monitor  (v2 — 2026-07-09)
#
# Runs every 5 min via com.prime.health LaunchAgent (GUI session,
# so it can restart daemons and reach the Gmail send path).
#
# Philosophy: fix what it can silently; email/text Zach ONLY when
# something is unfixable or needs a human (e.g. Claude re-login).
#
# Checks: daemons (serve/shift/claude-proxy/tunnel), serve API,
#         Claude auth (the month-long silent failure), brief
#         freshness (auto-regen), source sync freshness, DB, disk.
# ============================================================

PRIME_DIR="$HOME/GitHub/prime"
DB="$HOME/.prime/prime.db"
LOG="$HOME/.prime/logs/health-monitor.log"
ALERT_DIR="$HOME/.prime/health-alerts"
UID_Z=$(id -u)
mkdir -p "$ALERT_DIR"

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"
cd "$PRIME_DIR" || exit 1

log() { echo "[$(date '+%Y-%m-%d %H:%M')] $1" >> "$LOG"; }

# alert: dedup by message hash so a persistent issue pings once, not every 5 min.
alert() {
  local m="$1"
  local hash
  hash=$(echo "$m" | md5 -q)
  if [ ! -f "$ALERT_DIR/$hash" ]; then
    echo "$m" > "$ALERT_DIR/$hash"
    log "ALERT: $m"
    npx tsx scripts/prime-alert.ts "$m" >> "$LOG" 2>&1
  fi
}

# clear_alert: issue resolved -> allow a fresh alert if it recurs later.
clear_alert() {
  local hash
  hash=$(echo "$1" | md5 -q)
  rm -f "$ALERT_DIR/$hash" 2>/dev/null
}

restart_daemon() {  # label
  log "restarting $1..."
  launchctl kickstart -k "gui/$UID_Z/$1" 2>/dev/null
}

ISSUES=0

# ── 0. Manual self-test ────────────────────────────────
# `touch ~/.prime/health-selftest` -> next run pings ALL alert channels once.
# Bypasses dedup. Runs in the GUI session, so it's the valid iMessage test.
if [ -f "$HOME/.prime/health-selftest" ]; then
  rm -f "$HOME/.prime/health-selftest"
  log "self-test requested — pinging all alert channels"
  npx tsx scripts/prime-alert.ts "Self-test $(date '+%H:%M') — alert channels are working." >> "$LOG" 2>&1
fi

# ── 1. serve API responding ────────────────────────────
if curl -s --max-time 6 http://localhost:3210/api/health 2>/dev/null | grep -q '"ok"'; then
  clear_alert "serve API (port 3210) not responding"
else
  log "serve API not responding — restarting com.prime-recall.serve"
  restart_daemon "com.prime-recall.serve"
  sleep 8
  if curl -s --max-time 6 http://localhost:3210/api/health 2>/dev/null | grep -q '"ok"'; then
    log "✓ serve recovered"
    clear_alert "serve API (port 3210) not responding"
  else
    alert "serve API (port 3210) not responding and won't restart."
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 2. Claude auth via proxy  (THE month-long silent failure) ──
AUTH=$(curl -s --max-time 45 -X POST http://127.0.0.1:3211/claude \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Reply with exactly: OK","timeout":35}' 2>/dev/null)
if echo "$AUTH" | grep -qE '"exit_code":0'; then
  clear_alert "Claude auth FAILED (401) — Quinn cannot reason"
  clear_alert "claude-proxy not responding"
elif echo "$AUTH" | grep -qiE "401|authenticate|Invalid authentication"; then
  # OAuth expired — cannot be auto-fixed (browser re-login required).
  alert "Claude auth FAILED (401) — Quinn cannot reason. Fix: run 'claude' in a Terminal on the Mac Mini to re-login."
  ISSUES=$((ISSUES + 1))
else
  # Proxy itself not answering — try a restart.
  log "claude-proxy no/odd response — restarting"
  restart_daemon "com.prime.claude-proxy"
  sleep 6
  AUTH2=$(curl -s --max-time 45 -X POST http://127.0.0.1:3211/claude -H "Content-Type: application/json" \
    -d '{"prompt":"Reply with exactly: OK","timeout":35}' 2>/dev/null)
  if echo "$AUTH2" | grep -qE '"exit_code":0'; then
    log "✓ claude-proxy recovered"; clear_alert "claude-proxy not responding"
  else
    alert "claude-proxy not responding (port 3211) — Quinn/PM agents cannot run."
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 2b. Agents can actually use MCP tools (hourly; the "dark cycles" check) ──
# A passing proxy ping does NOT prove tools work. Ask for a real tool call.
if [ "$(date +%M)" -lt 5 ]; then
  TOOLS=$(curl -s --max-time 150 -X POST http://127.0.0.1:3211/claude \
    -H "Content-Type: application/json" \
    -d '{"prompt":"Call the prime_status MCP tool and reply with ONLY the total knowledge item count as a number. If the tool is unavailable reply exactly: NO_TOOLS","timeout":120}' 2>/dev/null)
  if echo "$TOOLS" | grep -qE '"exit_code":0' && ! echo "$TOOLS" | grep -q "NO_TOOLS" && echo "$TOOLS" | grep -qE '[0-9]{3,}'; then
    clear_alert "Agents have no MCP tools via proxy — Quinn/PMs are dark"
  else
    alert "Agents have no MCP tools via proxy — Quinn/PMs are dark"
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 3. shift daemon alive ──────────────────────────────
if pgrep -f "index.ts shift" >/dev/null 2>&1; then
  clear_alert "shift daemon (intelligence cycle) is down"
else
  log "shift daemon down — restarting"
  restart_daemon "com.prime.shift"
  sleep 5
  if pgrep -f "index.ts shift" >/dev/null 2>&1; then
    log "✓ shift recovered"; clear_alert "shift daemon (intelligence cycle) is down"
  else
    alert "shift daemon (intelligence cycle) won't start."
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 4. Intelligence brief freshness (auto-regen) ───────
LAST_BRIEF=$(sqlite3 "$DB" "SELECT MAX(created_at) FROM knowledge WHERE source='briefing'" 2>/dev/null)
if [ -n "$LAST_BRIEF" ]; then
  BRIEF_AGE=$(python3 -c "
from datetime import datetime, timezone
last = datetime.fromisoformat('${LAST_BRIEF}'.replace(' ', 'T'))
if last.tzinfo is None: last = last.replace(tzinfo=timezone.utc)
print(int((datetime.now(timezone.utc) - last).total_seconds() / 3600))
" 2>/dev/null)
  if [ -n "$BRIEF_AGE" ] && [ "$BRIEF_AGE" -gt 26 ]; then
    log "brief ${BRIEF_AGE}h stale — auto-regenerating via /api/briefing"
    curl -s --max-time 180 http://localhost:3210/api/briefing >/dev/null 2>&1
    NEW_BRIEF=$(sqlite3 "$DB" "SELECT MAX(created_at) FROM knowledge WHERE source='briefing'" 2>/dev/null)
    if [ "$NEW_BRIEF" != "$LAST_BRIEF" ]; then
      log "✓ brief regenerated"; clear_alert "Intelligence brief stale and won't regenerate"
    else
      alert "Intelligence brief ${BRIEF_AGE}h stale and auto-regen failed."
      ISSUES=$((ISSUES + 1))
    fi
  else
    clear_alert "Intelligence brief stale and won't regenerate"
  fi
fi

# ── 5. Source sync freshness ───────────────────────────
check_sync() {  # source  max_hours
  # Freshness = sync_state.last_sync_at, which only advances when a scan
  # COMPLETES successfully. MAX(created_at) of knowledge items was the old
  # signal and it false-alarmed: a quiet inbox or a replies-only stretch
  # creates no new items even though the connector is healthy.
  # Alert text is stable (no hour count) so md5 dedup fires once per
  # incident instead of hourly, and clear_alert can actually clear it.
  local LAST MSG
  MSG="$1 sync has not completed successfully in over ${2}h — connector or token may be broken."
  LAST=$(sqlite3 "$DB" "SELECT last_sync_at FROM sync_state WHERE source='$1'" 2>/dev/null)
  [ -z "$LAST" ] && LAST=$(sqlite3 "$DB" "SELECT MAX(created_at) FROM knowledge WHERE source='$1'" 2>/dev/null)
  [ -z "$LAST" ] && return
  local AGE
  AGE=$(python3 -c "
from datetime import datetime, timezone
last = datetime.fromisoformat('${LAST}'.replace(' ', 'T'))
if last.tzinfo is None: last = last.replace(tzinfo=timezone.utc)
print(int((datetime.now(timezone.utc) - last).total_seconds() / 3600))
" 2>/dev/null)
  if [ -n "$AGE" ] && [ "$AGE" -gt "$2" ]; then
    log "$1 sync stale: last success ${AGE}h ago (limit ${2}h)"
    alert "$MSG"
    ISSUES=$((ISSUES + 1))
  else
    clear_alert "$MSG"
  fi
}
check_sync "gmail" 6
check_sync "calendar" 12
check_sync "claude-code" 12
check_sync "fireflies" 96

# ── 6. DB integrity ────────────────────────────────────
INTEG=$(sqlite3 "$DB" "PRAGMA quick_check" 2>/dev/null | head -1)
if [ "$INTEG" = "ok" ]; then
  clear_alert "Database integrity check failed"
else
  alert "Database integrity check failed: $INTEG"
  ISSUES=$((ISSUES + 1))
fi

# ── 7. Disk space ──────────────────────────────────────
FREE=$(df -g "$HOME" | tail -1 | awk '{print $4}')
if [ -n "$FREE" ] && [ "$FREE" -lt 5 ]; then
  alert "Low disk space on Mac Mini: ${FREE}GB free."
  ISSUES=$((ISSUES + 1))
else
  clear_alert "Low disk space on Mac Mini"
fi

# ── 8. Tunnel (best-effort restart, no alert) ──────────
if ! pgrep -f "cloudflared" >/dev/null 2>&1; then
  log "tunnel down — restarting"; restart_daemon "com.prime-recall.tunnel"
fi

# ── 9. Mechanic dispatch ───────────────────────────────
# Alerts still present after 15 min (3 checks) are handed to the repair agent;
# so are issues Quinn filed via prime_report_issue. mechanic.sh has its own
# single-flight lock and 6h per-issue cooldown, so this is safe to call often.
MECH="$PRIME_DIR/scripts/mechanic.sh"
if [ -x "$MECH" ]; then
  NOW=$(date +%s)
  for f in "$ALERT_DIR"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.dispatched) continue;; esac
    [ -s "$f" ] || continue                       # legacy empty marker, no message
    AGE=$(( NOW - $(stat -f %m "$f") ))
    [ "$AGE" -ge 900 ] || continue
    if [ -f "$f.dispatched" ] && [ $(( NOW - $(stat -f %m "$f.dispatched") )) -lt 21600 ]; then continue; fi
    touch "$f.dispatched"
    log "mechanic ← watchdog: $(head -c 100 "$f")"
    nohup bash "$MECH" watchdog "$(cat "$f")" >/dev/null 2>&1 &
  done
  sqlite3 "$DB" "SELECT id || '|' || observation || ' — evidence: ' || COALESCE(why_wrong,'') FROM system_issues WHERE status='open' ORDER BY created_at ASC LIMIT 3" 2>/dev/null | while IFS='|' read -r IID ITEXT; do
    [ -n "$IID" ] || continue
    log "mechanic ← quinn issue ${IID:0:8}: $(echo "$ITEXT" | head -c 100)"
    nohup bash "$MECH" quinn "$ITEXT" "$IID" >/dev/null 2>&1 &
    sleep 1
  done
fi

if [ "$ISSUES" -eq 0 ]; then
  log "✓ all systems healthy"
else
  log "$ISSUES unresolved issue(s)"
fi

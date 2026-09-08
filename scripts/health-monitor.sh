#!/bin/bash
# ============================================================
# Prime Self-Healing Health Monitor  (v3 — 2026-08-31 audit rebuild)
#
# Runs every 5 min via com.prime.health LaunchAgent (GUI session,
# AbandonProcessGroup=true so dispatched mechanic runs survive exit).
#
# Philosophy: fix what it can silently; email/text Zach ONLY when
# something is unfixable or needs a human.
#
# v3 (audit): every check's alert/clear text is ONE variable — the
# 2026-08-31 audit found 7 of 9 checks had mismatched alert vs clear
# strings, so resolved alerts never cleared (md5-keyed files leaked),
# permanently silencing re-alerts and re-dispatching the mechanic
# every 6h forever. Changing detail (hours, GB) goes in log() only.
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

# clear_alert: issue resolved -> remove marker AND its dispatch marker.
clear_alert() {
  local hash
  hash=$(echo "$1" | md5 -q)
  rm -f "$ALERT_DIR/$hash" "$ALERT_DIR/$hash.dispatched" 2>/dev/null
}

restart_daemon() {  # label
  log "restarting $1..."
  launchctl kickstart -k "gui/$UID_Z/$1" 2>/dev/null
}

ISSUES=0

# Stable alert texts — used by BOTH alert() and clear_alert(). Never
# embed changing numbers here; put those in log() lines.
MSG_SERVE="serve API (port 3210) is down and would not restart."
MSG_AUTH="Claude auth FAILED (401) — Quinn cannot reason. Fix: run 'claude' in a Terminal on the Mac Mini to re-login."
MSG_PROXY="claude-proxy not responding (port 3211) — Quinn/PM agents cannot run."
MSG_QUOTA="Claude usage limit hit — proxy is fine, quota is exhausted. Agents resume when the limit resets; no restart needed."
MSG_TOOLS="Agents have no MCP tools via proxy — Quinn/PMs are dark."
MSG_SHIFT="shift daemon (intelligence cycle) is down and would not restart."
MSG_BRIEF="Intelligence brief is stale and auto-regen failed."
MSG_DB="Database integrity check failed."
MSG_DISK="Low disk space on Mac Mini."
MSG_DEEPSEEK="DeepSeek API balance depleted — wiki compilation and claim verification fail every 4h cycle. Top up at platform.deepseek.com."
MSG_MONITORS="pm_agents roster is missing or has zero active monitors — all PM agents dark."

# ── 0. Manual self-test ────────────────────────────────
if [ -f "$HOME/.prime/health-selftest" ]; then
  rm -f "$HOME/.prime/health-selftest"
  log "self-test requested — pinging all alert channels"
  npx tsx scripts/prime-alert.ts "Self-test $(date '+%H:%M') — alert channels are working." >> "$LOG" 2>&1
fi

# ── 1. serve API responding ────────────────────────────
if curl -s --max-time 6 http://localhost:3210/api/health 2>/dev/null | grep -q '"ok"'; then
  clear_alert "$MSG_SERVE"
else
  log "serve API not responding — restarting com.prime-recall.serve"
  restart_daemon "com.prime-recall.serve"
  sleep 8
  if curl -s --max-time 6 http://localhost:3210/api/health 2>/dev/null | grep -q '"ok"'; then
    log "✓ serve recovered"
    clear_alert "$MSG_SERVE"
  else
    alert "$MSG_SERVE"
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 2. Claude auth via proxy ───────────────────────────
# The proxy now runs ONE claude child at a time; a probe sent mid-agent-run
# queues behind a 5-15 min session and times out as a false failure. If a
# claude child is alive, the proxy is self-evidently up and authed — skip.
if pgrep -f "/opt/homebrew/bin/claude" >/dev/null 2>&1; then
  log "claude busy with an agent run — skipping auth probe"
else
AUTH=$(curl -s --max-time 45 -X POST http://127.0.0.1:3211/claude \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Reply with exactly: OK","timeout":35}' 2>/dev/null)
if echo "$AUTH" | grep -qE '"exit_code":0'; then
  clear_alert "$MSG_AUTH"; clear_alert "$MSG_PROXY"; clear_alert "$MSG_QUOTA"
elif echo "$AUTH" | grep -qiE "401|authenticate|Invalid authentication"; then
  alert "$MSG_AUTH"
  ISSUES=$((ISSUES + 1))
elif echo "$AUTH" | grep -qiE "usage limit|rate.?limit|overloaded|resets at"; then
  # Quota exhaustion is NOT a proxy failure — restarting would kill any
  # in-flight agent session for nothing (audit finding 2026-08-31).
  log "Claude quota/rate limit hit — not restarting proxy"
  alert "$MSG_QUOTA"
  ISSUES=$((ISSUES + 1))
else
  log "claude-proxy no/odd response — restarting"
  restart_daemon "com.prime.claude-proxy"
  sleep 6
  AUTH2=$(curl -s --max-time 45 -X POST http://127.0.0.1:3211/claude -H "Content-Type: application/json" \
    -d '{"prompt":"Reply with exactly: OK","timeout":35}' 2>/dev/null)
  if echo "$AUTH2" | grep -qE '"exit_code":0'; then
    log "✓ claude-proxy recovered"; clear_alert "$MSG_PROXY"
  else
    alert "$MSG_PROXY"
    ISSUES=$((ISSUES + 1))
  fi
fi
fi  # end busy-skip guard

# ── 2b. Agents can actually use MCP tools (hourly) ─────
if [ "$(date +%M)" -lt 5 ]; then
  TOOLS=$(curl -s --max-time 150 -X POST http://127.0.0.1:3211/claude \
    -H "Content-Type: application/json" \
    -d '{"prompt":"Call the prime_status MCP tool and reply with ONLY the total knowledge item count as a number. If the tool is unavailable reply exactly: NO_TOOLS","timeout":120}' 2>/dev/null)
  # Parse the JSON and test only the result field — digits in the JSON
  # wrapper (session ids) made the old grep false-pass (audit finding).
  if echo "$TOOLS" | python3 -c '
import json, sys, re
try: d = json.load(sys.stdin)
except Exception: sys.exit(1)
r = str(d.get("result", ""))
sys.exit(0 if d.get("exit_code") == 0 and "NO_TOOLS" not in r and re.search(r"[0-9]{3,}", r) else 1)
' 2>/dev/null; then
    clear_alert "$MSG_TOOLS"
  else
    alert "$MSG_TOOLS"
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 3. shift daemon alive ──────────────────────────────
if pgrep -f "index.ts shift" >/dev/null 2>&1; then
  clear_alert "$MSG_SHIFT"
else
  log "shift daemon down — restarting"
  restart_daemon "com.prime.shift"
  sleep 5
  if pgrep -f "index.ts shift" >/dev/null 2>&1; then
    log "✓ shift recovered"; clear_alert "$MSG_SHIFT"
  else
    alert "$MSG_SHIFT"
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 4. (retired 2026-08-31) The /api/briefing artifact was a second, unread
#      briefing generator; Quinn's daily email is THE brief. Its freshness
#      check (4b) is the only brief check now. /api/briefing stays on-demand.
clear_alert "$MSG_BRIEF"

# ── 4b. Morning brief actually went out ────────────────
# The brief is Zach's single surface — if it silently fails, a broken day
# looks identical to a quiet one. Alert if nothing sent by 8am local.
MSG_NOBRIEF="Morning brief did not go out by 9:30 — daily email pipeline is broken."
HOUR_NOW=$(date +%H)
MIN_NOW=$(date +%M)
DOW_NOW=$(date +%u)  # 6=Sat 7=Sun — weekends have no brief by design
# 9:30 gate: with 7 sequential Opus PMs a 7:08 cycle can block ticks until
# ~8:40; alerting at 8:00 would false-alarm near-daily (audit 2026-08-31).
if [ "$DOW_NOW" -lt 6 ] && { [ "$HOUR_NOW" -gt 9 ] || { [ "$HOUR_NOW" -eq 9 ] && [ "$MIN_NOW" -ge 30 ]; }; } && [ "$HOUR_NOW" -lt 22 ]; then
  LAST_QE=$(sqlite3 "$DB" "SELECT value FROM graph_state WHERE key='last_quinn_email'" 2>/dev/null | tr -d '"')
  TODAY_LOCAL=$(date +%Y-%m-%d)
  SENT_DAY=$(python3 -c "
from datetime import datetime, timezone
import sys
try:
    d = datetime.fromisoformat('${LAST_QE}'.replace('Z','+00:00'))
    print(d.astimezone().strftime('%Y-%m-%d'))
except Exception:
    print('never')
" 2>/dev/null)
  if [ "$SENT_DAY" = "$TODAY_LOCAL" ]; then
    clear_alert "$MSG_NOBRIEF"
  else
    alert "$MSG_NOBRIEF"
    ISSUES=$((ISSUES + 1))
  fi
else
  clear_alert "$MSG_NOBRIEF"
fi

# ── 5. Source sync freshness ───────────────────────────
check_sync() {  # source  max_hours
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
  clear_alert "$MSG_DB"
else
  log "DB integrity: $INTEG"
  alert "$MSG_DB"
  ISSUES=$((ISSUES + 1))
fi

# ── 7. Disk space ──────────────────────────────────────
FREE=$(df -g "$HOME" | tail -1 | awk '{print $4}')
if [ -n "$FREE" ] && [ "$FREE" -lt 5 ]; then
  log "disk free: ${FREE}GB"
  alert "$MSG_DISK"
  ISSUES=$((ISSUES + 1))
else
  clear_alert "$MSG_DISK"
fi

# ── 7b. DeepSeek API balance ───────────────────────────
DS_KEY=$(grep '^DEEPSEEK_API_KEY=' "$PRIME_DIR/.env" 2>/dev/null | cut -d= -f2-)
if [ -n "$DS_KEY" ]; then
  DS_BAL=$(printf 'header = "Authorization: Bearer %s"\n' "$DS_KEY" | curl -s --max-time 10 -K - https://api.deepseek.com/user/balance 2>/dev/null)
  if echo "$DS_BAL" | grep -q '"is_available":true'; then
    clear_alert "$MSG_DEEPSEEK"
    BAL_NOW=$(echo "$DS_BAL" | python3 -c "import sys,json;print(json.load(sys.stdin)['balance_infos'][0]['total_balance'])" 2>/dev/null)
    [ -n "$BAL_NOW" ] && log "deepseek balance: \$$BAL_NOW"
  else
    alert "$MSG_DEEPSEEK"
    ISSUES=$((ISSUES + 1))
  fi
fi

# ── 7c. Monitor roster sanity ──────────────────────────
ACTIVE_PMS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM pm_agents WHERE active=1" 2>/dev/null)
if [ -n "$ACTIVE_PMS" ] && [ "$ACTIVE_PMS" -gt 0 ]; then
  clear_alert "$MSG_MONITORS"
else
  alert "$MSG_MONITORS"
  ISSUES=$((ISSUES + 1))
fi

# ── 8. Tunnel (best-effort restart, no alert) ──────────
if ! pgrep -f "cloudflared" >/dev/null 2>&1; then
  log "tunnel down — restarting"; restart_daemon "com.prime-recall.tunnel"
fi

# ── 9. Mechanic dispatch ───────────────────────────────
# Alerts still present after 15 min (3 checks) are handed to the repair agent;
# so are issues Quinn filed via prime_report_issue. mechanic.sh has its own
# single-flight lock, per-issue cooldown, and attempt cap.
MECH="$PRIME_DIR/scripts/mechanic.sh"
if [ -x "$MECH" ]; then
  NOW=$(date +%s)
  for f in "$ALERT_DIR"/*; do
    [ -f "$f" ] || continue
    case "$f" in *.dispatched) continue;; esac
    # Legacy zero-byte markers carry no message and silence future alerts
    # for their hash — remove them (audit finding 2026-08-31).
    [ -s "$f" ] || { rm -f "$f"; continue; }
    # Brief-timing alerts are watchdog-only — a mechanic session cannot fix
    # "the cycle is slow" and would poke the system mid-cycle (audit finding)
    grep -q "Morning brief did not go out" "$f" 2>/dev/null && continue
    AGE=$(( NOW - $(stat -f %m "$f") ))
    [ "$AGE" -ge 900 ] || continue
    if [ -f "$f.dispatched" ] && [ $(( NOW - $(stat -f %m "$f.dispatched") )) -lt 21600 ]; then continue; fi
    touch "$f.dispatched"
    log "mechanic ← watchdog: $(head -c 100 "$f")"
    nohup bash "$MECH" watchdog "$(cat "$f")" >/dev/null 2>&1 &
  done
  # Quinn-filed issues: newline-flattened (multi-line observations broke the
  # line-based read), never-attempted first so stuck issues can't starve new ones.
  sqlite3 "$DB" "SELECT id || '|' || replace(replace(observation,char(10),' '),char(13),' ') || ' — evidence: ' || replace(replace(COALESCE(why_wrong,''),char(10),' '),char(13),' ') FROM system_issues WHERE status='open' ORDER BY (result_status IS NULL) DESC, created_at ASC LIMIT 3" 2>/dev/null | while IFS='|' read -r IID ITEXT; do
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

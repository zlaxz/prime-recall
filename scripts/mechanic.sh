#!/bin/bash
# Prime Mechanic — autonomous infrastructure repair agent.
#
# Usage: mechanic.sh <source> "<issue description>" [issue_id]
#   source   = watchdog | quinn | manual
#   issue_id = system_issues.id when dispatched from a Quinn report
#
# Dispatched by health-monitor.sh when an alert survives its restarts, or when
# Quinn files an issue via prime_report_issue. Runs claude -p through the proxy
# (Keychain auth) with Bash/Read/Edit, identity from ~/.prime/agents/mechanic/,
# then emails Zach the report and appends new playbook entries.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin"
export HOME="${HOME:-/Users/zachstock}"

PRIME_DIR="$HOME/GitHub/prime"
AGENT_DIR="$HOME/.prime/agents/mechanic"
REPORTS="$AGENT_DIR/reports"
COOLDOWN_DIR="$AGENT_DIR/cooldown"
LOG="$HOME/.prime/logs/mechanic.log"
LOCK="$HOME/.prime/mechanic.lock"
DB="$HOME/.prime/prime.db"
PROXY="http://127.0.0.1:3211/claude"
UID_Z=$(id -u)

SOURCE="${1:-manual}"
ISSUE="${2:-}"
ISSUE_ID="${3:-}"
AGENT_TIMEOUT=1800   # seconds the agent may run
COOLDOWN=21600       # 6h before re-dispatching the same issue text
LOCK_STALE=7200      # break a lock older than 2h

mkdir -p "$REPORTS" "$COOLDOWN_DIR" "$(dirname "$LOG")"
log() { echo "[$(date '+%Y-%m-%d %H:%M')] $1" >> "$LOG"; }

if [ -z "$ISSUE" ]; then echo "usage: mechanic.sh <source> \"<issue>\" [issue_id]"; exit 1; fi

sqlite3 "$DB" "CREATE TABLE IF NOT EXISTS system_issues (
  id TEXT PRIMARY KEY, reported_by TEXT, observation TEXT, why_wrong TEXT,
  status TEXT DEFAULT 'open', result_status TEXT, report_path TEXT,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')))" 2>/dev/null

# ── single-flight lock ──────────────────────────────────
if [ -f "$LOCK" ]; then
  AGE=$(( $(date +%s) - $(stat -f %m "$LOCK") ))
  if [ "$AGE" -lt "$LOCK_STALE" ]; then log "busy (lock ${AGE}s old) — skipping: ${ISSUE:0:80}"; exit 0; fi
  log "breaking stale lock (${AGE}s)"
fi
echo $$ > "$LOCK"
trap 'rm -f "$LOCK"' EXIT

# ── per-issue cooldown ──────────────────────────────────
HASH=$(echo "$ISSUE" | md5 -q)
STAMP="$COOLDOWN_DIR/$HASH"
if [ -f "$STAMP" ] && [ $(( $(date +%s) - $(stat -f %m "$STAMP") )) -lt "$COOLDOWN" ]; then
  log "cooldown — skipping: ${ISSUE:0:80}"; exit 0
fi
touch "$STAMP"
[ -n "$ISSUE_ID" ] && sqlite3 "$DB" "UPDATE system_issues SET status='dispatched', updated_at=datetime('now') WHERE id='$ISSUE_ID'" 2>/dev/null

log "START [$SOURCE] ${ISSUE:0:120}"
RUN_ID=$(date +%Y%m%d-%H%M%S)
WORK=$(mktemp -d /tmp/mechanic.XXXXXX)

# ── context bundle ──────────────────────────────────────
{
  echo "# DISPATCH"
  echo "Source: $SOURCE    Run: $RUN_ID    Date: $(date)"
  echo
  echo "## THE ISSUE"
  echo "$ISSUE"
  echo
  echo "## SNAPSHOT (taken by the runner just now)"
  echo '```'
  echo "--- launchctl list | grep prime"; launchctl list | grep -E "prime"
  echo "--- serve /api/health"; curl -s --max-time 5 http://localhost:3210/api/health; echo
  echo "--- proxy /health"; curl -s --max-time 5 http://localhost:3211/health; echo
  echo "--- git (cd $PRIME_DIR)"; (cd "$PRIME_DIR" && git branch --show-current && git status --short | head -20 && git log --oneline -5)
  echo "--- open system_issues"; sqlite3 "$DB" "SELECT substr(id,1,8), reported_by, status, substr(observation,1,100) FROM system_issues WHERE status IN ('open','dispatched') ORDER BY created_at DESC LIMIT 5" 2>/dev/null
  echo '```'
  for f in health-monitor.log shift.log serve-error.log shift-error.log mechanic.log; do
    echo; echo "## tail ~/.prime/logs/$f"; echo '```'
    tail -n 40 "$HOME/.prime/logs/$f" 2>/dev/null | cut -c1-400
    echo '```'
  done
  echo
  echo "## PREVIOUS MECHANIC REPORTS (most recent 2)"
  for r in $(ls -t "$REPORTS"/*.md 2>/dev/null | head -2); do echo "### $(basename "$r")"; head -c 1500 "$r"; echo; done
} > "$WORK/context.md"

cat "$AGENT_DIR/SOUL.md" > "$WORK/prompt.md"
printf '\n\n' >> "$WORK/prompt.md"
cat "$AGENT_DIR/REPAIR_PLAYBOOK.md" >> "$WORK/prompt.md"
printf '\n\n' >> "$WORK/prompt.md"
cat "$WORK/context.md" >> "$WORK/prompt.md"
printf '\n\nBegin. Remember: cd ~/GitHub/prime first; one issue; report format exactly; your final message is the report.\n' >> "$WORK/prompt.md"

python3 - "$WORK/prompt.md" "$WORK/body.json" "$PRIME_DIR" "$AGENT_TIMEOUT" <<'PY'
import json, sys
prompt = open(sys.argv[1]).read()
body = {
  "prompt": prompt,
  "timeout": int(sys.argv[4]),
  "args": ["--allowedTools", "Bash,Read,Edit,Write,Grep,Glob",
           "--add-dir", sys.argv[3],
           "--max-turns", "200"],
}
json.dump(body, open(sys.argv[2], "w"))
print(f"prompt bytes: {len(prompt.encode())}")
PY

# ── run the agent via the proxy (curl, never http.request) ──
RESP=$(curl -s --max-time $((AGENT_TIMEOUT + 60)) -X POST "$PROXY" \
  -H "Content-Type: application/json" -d @"$WORK/body.json")
export RESP

python3 - "$WORK" <<'PY' > "$WORK/parsed.txt"
import json, sys, os
w = sys.argv[1]
raw = os.environ.get("RESP", "")
try:
    d = json.loads(raw)
except Exception:
    d = {"error": f"unparseable proxy response: {raw[:300]}"}
report = d.get("result") or ""
err = d.get("error")
if err and not report:
    report = f"STATUS: PARTIAL\nHEADLINE: Mechanic run did not complete — proxy error\n\n## What I found\nProxy returned: {err}\n"
open(os.path.join(w, "report.md"), "w").write(report)
status = "UNKNOWN"
headline = ""
for line in report.splitlines():
    if line.startswith("STATUS:") and status == "UNKNOWN":
        words = line.split(":", 1)[1].strip().split()
        if words: status = words[0].strip("*` ")
    if line.startswith("HEADLINE:") and not headline:
        headline = line.split(":", 1)[1].strip()
pb = ""
if "---PLAYBOOK---" in report:
    pb = report.split("---PLAYBOOK---",1)[1].strip()
    if pb.startswith("```"): pb = pb.strip("`").strip()
open(os.path.join(w, "playbook.txt"), "w").write(pb)
print(status); print(headline)
PY
STATUS=$(sed -n 1p "$WORK/parsed.txt"); HEADLINE=$(sed -n 2p "$WORK/parsed.txt")
REPORT_PATH="$REPORTS/$RUN_ID-$STATUS.md"
{ echo "# Mechanic run $RUN_ID — $STATUS"; echo "Source: $SOURCE"; echo "Issue: $ISSUE"; echo; cat "$WORK/report.md"; } > "$REPORT_PATH"
log "DONE  [$STATUS] $HEADLINE"

# ── proxy restart requested by the agent? (it cannot do this itself) ──
if [ -f "$AGENT_DIR/restart-proxy.flag" ]; then
  rm -f "$AGENT_DIR/restart-proxy.flag"
  log "agent requested proxy rebuild+restart — running build.sh"
  (cd "$PRIME_DIR" && bash scripts/claude-proxy/build.sh >> "$LOG" 2>&1)
fi

# ── append playbook entry ───────────────────────────────
if [ "$STATUS" = "FIXED" ] && [ -s "$WORK/playbook.txt" ]; then
  { echo; cat "$WORK/playbook.txt"; echo; } >> "$AGENT_DIR/REPAIR_PLAYBOOK.md"
  log "playbook entry appended"
fi

# ── record in knowledge base + system_issues ────────────
python3 - "$DB" "$REPORT_PATH" "$STATUS" "$HEADLINE" "$SOURCE" "$ISSUE_ID" "$ISSUE" <<'PY'
import sqlite3, sys, uuid, datetime
db, path, status, headline, source, issue_id, issue = sys.argv[1:8]
body = open(path).read()
con = sqlite3.connect(db)
now = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")
title = f"Mechanic {status}: {headline or issue[:80]}"
try:
    con.execute("INSERT INTO knowledge (id, title, summary, source, source_ref, source_date, created_at) VALUES (?,?,?,?,?,?,?)",
                (str(uuid.uuid4()), title, body[:6000], "mechanic-report", path, now, now))
except Exception as e:
    print("knowledge insert failed:", e)
if issue_id:
    final = "resolved" if status == "FIXED" else ("open" if status in ("PARTIAL","UNKNOWN") else "closed")
    con.execute("UPDATE system_issues SET status=?, result_status=?, report_path=?, updated_at=datetime('now') WHERE id=?",
                (final, status, path, issue_id))
con.commit()
PY

# ── close other issues the agent verified as already resolved ──
python3 - "$DB" "$WORK/report.md" <<'PY'
import sqlite3, sys, re
db, path = sys.argv[1:3]
r = open(path).read()
m = re.search(r"^RESOLVED_ISSUES:\s*([0-9a-f, ]+)$", r, re.M)
if not m: sys.exit(0)
con = sqlite3.connect(db)
for short in [x.strip() for x in m.group(1).split(",") if x.strip()]:
    con.execute("UPDATE system_issues SET status='resolved', result_status='verified-by-mechanic', updated_at=datetime('now') WHERE id LIKE ? || '%' AND status IN ('open','dispatched')", (short,))
con.commit()
PY

# ── file anything the agent "also noticed" as new issues ──
python3 - "$DB" "$WORK/report.md" <<'PY'
import sqlite3, sys, uuid, re
db, path = sys.argv[1:3]
r = open(path).read()
m = re.search(r"## Also noticed\s*\n(.*?)(?:\n## |\n---PLAYBOOK---|\Z)", r, re.S)
if not m: sys.exit(0)
text = m.group(1).strip()
if not text or text.lower().startswith("nothing"): sys.exit(0)
con = sqlite3.connect(db)
for line in [l.strip("-* ").strip() for l in text.splitlines() if l.strip("-* ").strip()][:3]:
    dup = con.execute("SELECT 1 FROM system_issues WHERE status IN ('open','dispatched') AND observation=?", (line,)).fetchone()
    if not dup:
        con.execute("INSERT INTO system_issues (id, reported_by, observation, why_wrong) VALUES (?,?,?,?)",
                    (str(uuid.uuid4()), "mechanic", line, "noticed during a repair run"))
con.commit()
PY

# ── deliver to Zach ─────────────────────────────────────
MSG="MECHANIC $STATUS — $HEADLINE

Issue ($SOURCE): ${ISSUE:0:300}

$(cat "$WORK/report.md" | head -c 6000)

Full report: $REPORT_PATH"
(cd "$PRIME_DIR" && npx tsx scripts/prime-alert.ts "$MSG" >> "$LOG" 2>&1)

rm -rf "$WORK"
exit 0

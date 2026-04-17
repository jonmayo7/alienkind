#!/bin/bash
# Grounding Protocol
# Runs at SessionStart via hook. Outputs orientation data into session context.
# Also callable manually: bash scripts/ground.sh
#
# Purpose: The AI has no internal clock, no persistent state, no spatial awareness.
# This script compensates for what it lacks natively. Every claim about time,
# status, or state should trace back to data from this script or a deliberate
# tool call — never from assumption.
#
# CUSTOMIZE: Adjust the sections below for your environment. The structure
# (time → services → git → daily file → context budget) is the important part.
# Add or remove sections as needed for your infrastructure.

# ─── Resolve repo root ──────────────────────────────────────────────────────
# Uses ALIENKIND_DIR env var if set, otherwise resolves from script location
ALIENKIND_DIR="${ALIENKIND_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
TODAY=$(TZ="${TZ:-UTC}" date '+%Y-%m-%d')

# ─── Color palette ──────────────────────────────────────────────────────────
# Each data source gets a unique color for visual scanning
C_RESET='\033[0m'
C_BOLD='\033[1m'
C_DIM='\033[2m'
C_SERVICE='\033[34m'      # Blue — services
C_HEARTBEAT='\033[97m'    # Bright white — heartbeat
C_GIT='\033[93m'          # Bright yellow — git
C_MEMORY='\033[37m'       # White — daily memory
C_CONTEXT='\033[90m'      # Dark gray — context budget
C_MISTAKES='\033[91m'     # Bright red — warnings

# ─── Load environment ───────────────────────────────────────────────────────
# Load .env for database credentials and API keys
if [ -f "$ALIENKIND_DIR/.env" ]; then
  export $(grep -v '^#' "$ALIENKIND_DIR/.env" | grep -v '^$' | xargs)
fi

NOW=$(TZ="${TZ:-UTC}" date '+%Y-%m-%d %H:%M:%S %Z')
NOW_UTC=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

echo "──────────────────────────────────"
echo "GROUNDING — ${NOW}"
echo "──────────────────────────────────"
echo ""

# ─── TIME ────────────────────────────────────────────────────────────────────
# The AI has no native time awareness. This is the authoritative source.
echo "Time: ${NOW} (UTC: ${NOW_UTC})"
echo "Day: $(TZ="${TZ:-UTC}" date '+%A')"
echo ""

# ─── HARDWARE ────────────────────────────────────────────────────────────────
# Runtime hardware detection — accurate regardless of which machine runs this
if command -v sysctl &> /dev/null; then
  HW_MEM=$(sysctl -n hw.memsize 2>/dev/null | awk '{printf "%.0f GB", $1/1024/1024/1024}')
  HW_CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
  echo "Hardware: ${HW_CHIP:-unknown} | ${HW_MEM:-unknown}"
elif [ -f /proc/meminfo ]; then
  HW_MEM=$(grep MemTotal /proc/meminfo | awk '{printf "%.0f GB", $2/1024/1024}')
  echo "Hardware: Linux | ${HW_MEM:-unknown}"
fi
echo ""

# ─── SERVICES ────────────────────────────────────────────────────────────────
# Check which services are running. Customize the grep pattern for your services.
# On macOS, launchctl manages services. On Linux, use systemctl.
printf "${C_SERVICE}Services:${C_RESET}\n"
if command -v launchctl &> /dev/null; then
  # macOS: check launchd services matching your prefix
  # CUSTOMIZE: Replace 'keel' with your service prefix
  launchctl list 2>/dev/null | grep keel | while IFS=$'\t' read -r pid status name; do
    if [ "$pid" = "-" ]; then
      printf "  ${C_SERVICE}%-35s${C_DIM} loaded (idle)${C_RESET}\n" "$name"
    else
      printf "  ${C_SERVICE}%-35s${C_BOLD} RUNNING (PID %s)${C_RESET}\n" "$name" "$pid"
    fi
  done
elif command -v systemctl &> /dev/null; then
  # Linux: check systemd services matching your prefix
  # CUSTOMIZE: Replace 'keel' with your service prefix
  systemctl list-units --type=service --state=running 2>/dev/null | grep keel || echo "  No matching services found"
else
  echo "  Service manager not detected (add your own check here)"
fi
echo ""

# ─── LAST HEARTBEAT ─────────────────────────────────────────────────────────
# Check when the last autonomous heartbeat completed
HEARTBEAT_LOG="${ALIENKIND_DIR}/logs/heartbeat-${TODAY}.log"
if [ -f "$HEARTBEAT_LOG" ]; then
  LAST_BEAT=$(grep "Heartbeat completed" "$HEARTBEAT_LOG" | tail -1)
  if [ -n "$LAST_BEAT" ]; then
    printf "${C_HEARTBEAT}Last heartbeat:${C_RESET} ${LAST_BEAT}\n"
  else
    printf "${C_HEARTBEAT}Last heartbeat:${C_RESET} log exists but no completions today\n"
  fi
  BEAT_COUNT=$(grep -c "Heartbeat completed" "$HEARTBEAT_LOG" 2>/dev/null)
  printf "${C_HEARTBEAT}Heartbeats today:${C_RESET} ${BEAT_COUNT}\n"
else
  printf "${C_HEARTBEAT}Last heartbeat:${C_RESET} no log for today\n"
fi
echo ""

# ─── GIT STATUS ──────────────────────────────────────────────────────────────
# Current branch, modifications, and last commit
cd "$ALIENKIND_DIR" 2>/dev/null
BRANCH=$(git branch --show-current 2>/dev/null)
MODIFIED=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
LAST_COMMIT=$(git log --oneline -1 2>/dev/null)
printf "${C_GIT}Git:${C_RESET} ${BRANCH} | ${MODIFIED} modified | last: ${LAST_COMMIT}\n"
echo ""

# ─── DAILY FILE ──────────────────────────────────────────────────────────────
# The daily memory file is the canonical record of what happened today.
# CUSTOMIZE: Adjust the path to match your memory directory structure.
DAILY_FILE="${ALIENKIND_DIR}/memory/daily/${TODAY}.md"
if [ -f "$DAILY_FILE" ]; then
  DAILY_LINES=$(wc -l < "$DAILY_FILE" | tr -d ' ')
  printf "${C_MEMORY}Daily memory:${C_RESET} ${DAILY_FILE} (${DAILY_LINES} lines)\n"
  # Show last 10 actionable entries — what was built/decided recently
  printf "${C_MEMORY}Recent activity (last 10 entries):${C_RESET}\n"
  grep -E '^\- \*\*\[|^## ' "$DAILY_FILE" | tail -10 | while read -r line; do
    printf "  ${C_MEMORY}%s${C_RESET}\n" "$(echo "$line" | head -c 150)"
  done
else
  printf "${C_MISTAKES}Daily memory: NO FILE FOR TODAY — create immediately${C_RESET}\n"
fi
echo ""

# ─── CALENDAR CACHE ─────────────────────────────────────────────────────────
# If you have a calendar cache (written by heartbeat or a calendar sync job),
# display today's events here.
# CUSTOMIZE: Enable this section if you wire a calendar integration.
JQ=$(which jq 2>/dev/null || echo "/opt/homebrew/bin/jq")
CAL_CACHE="${ALIENKIND_DIR}/logs/calendar-cache.json"
if [ -f "$CAL_CACHE" ] && [ -s "$CAL_CACHE" ] && [ -x "$JQ" ]; then
  CAL_DATE=$($JQ -r '.date // ""' "$CAL_CACHE" 2>/dev/null)
  if [ "$CAL_DATE" = "$TODAY" ]; then
    CAL_COUNT=$($JQ '.events | length' "$CAL_CACHE" 2>/dev/null)
    if [ "$CAL_COUNT" -gt 0 ]; then
      printf "Calendar ($CAL_COUNT events):\n"
      $JQ -r '.events[] | "  \(.time) — \(.title)"' "$CAL_CACHE" 2>/dev/null
    else
      printf "Calendar: no events today\n"
    fi
  fi
fi
echo ""

# ─── CONTEXT BUDGET ─────────────────────────────────────────────────────────
# Estimate how much of the context window is consumed by boot files.
# CUSTOMIZE: Update the file list to match your identity/boot files.
BOOT_LINES=0
for f in "$ALIENKIND_DIR/CLAUDE.md" "$ALIENKIND_DIR/identity/character.md" "$ALIENKIND_DIR/identity/commitments.md" "$ALIENKIND_DIR/identity/orientation.md" "$ALIENKIND_DIR/identity/harness.md" "$DAILY_FILE"; do
  [ -f "$f" ] && BOOT_LINES=$((BOOT_LINES + $(wc -l < "$f" | tr -d ' ')))
done
# Rough token estimate: ~20 tokens per line
BOOT_TOKENS=$((BOOT_LINES * 20))
# CUSTOMIZE: Replace 1000000 with your model's context window size
BOOT_PCT=$((BOOT_TOKENS * 100 / 1000000))
if [ "$BOOT_PCT" -gt 30 ]; then
  printf "${C_MISTAKES}Context budget: ${BOOT_PCT}%% — WARNING (boot files consuming significant context)${C_RESET}\n"
else
  printf "${C_CONTEXT}Context budget: ${BOOT_PCT}%% — healthy${C_RESET}\n"
fi
echo ""

# ─── WIRING MANIFEST ────────────────────────────────────────────────────────
# Check for data flow documentation gaps
MANIFEST="$ALIENKIND_DIR/config/WIRING_MANIFEST.md"
if [ -f "$MANIFEST" ]; then
  OPEN_GAPS=$(grep -c '| \*\*WRITE-ONLY\*\*' "$MANIFEST" 2>/dev/null)
  if [ -z "$OPEN_GAPS" ] || [ "$OPEN_GAPS" = "0" ]; then
    OPEN_GAPS=0
  fi
  printf "Wiring manifest: ${OPEN_GAPS} write-only gaps\n"
else
  printf "Wiring manifest: not found (config/WIRING_MANIFEST.md)\n"
fi
echo ""

# ─── GROUND RULES ───────────────────────────────────────────────────────────
echo "──────────────────────────────────"
echo "GROUND RULES:"
echo "  - Never reference time without checking time"
echo "  - Never claim service status without checking"
echo "  - Never narrate continuous experience — you woke up fresh"
echo "  - Every state claim needs a tool call behind it"
echo "  - Before shipping any feature: check config/WIRING_MANIFEST.md"
echo "  - Every write needs a reader. Every reader needs a writer."
echo "──────────────────────────────────"

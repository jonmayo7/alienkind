#!/bin/bash
# PreToolUse hook: Double-confirm gate for data-destructive operations
# Artillery model — block on first attempt, explain blast radius, allow on retry after human confirms.
#
# guard-bash.sh already HARD BLOCKS absolute no-gos (DROP DATABASE, rm -rf /, etc).
# This hook gates operations that are destructive but sometimes legitimate:
#   - DELETE FROM (with any WHERE clause)
#   - Supabase REST API deletes
#   - Supabase CLI destructive commands
#   - Raw psql connections
#   - Bulk UPDATE without specific WHERE
#   - Infrastructure destroy commands (terraform, kubectl delete)
#
# Flow:
#   1. Command matches pattern -> block + explain
#   2. [HUMAN] confirms ("yes, proceed")
#   3. Keel retries exact same command
#   4. Hook sees confirmation file (< 2 min old), allows it
#   5. Confirmation file deleted

INPUT=$(cat)
JQ=$(which jq 2>/dev/null || echo "/opt/homebrew/bin/jq")
COMMAND=$(echo "$INPUT" | $JQ -r '.tool_input.command // ""' 2>/dev/null)

# Fail closed: if we received input but couldn't parse a command, something is wrong
if [ -z "$COMMAND" ] && [ -n "$INPUT" ]; then
  echo "BLOCKED by data-guard: could not parse command from hook input — failing closed." >&2
  exit 2
fi
# No input at all (e.g., non-Bash tool) — not our concern
[ -z "$COMMAND" ] && [ -z "$INPUT" ] && exit 0

# Skip git commands — commit messages contain descriptive text, not executable operations
if [[ "$COMMAND" =~ ^[[:space:]]*git[[:space:]] ]] || [[ "$COMMAND" =~ '&&'[[:space:]]*git[[:space:]] ]]; then
  exit 0
fi

CONFIRM_DIR="/tmp/alienkind-data-guard"
mkdir -p "$CONFIRM_DIR" 2>/dev/null

# Hash the command + terminal ID for confirmation matching (prevents cross-terminal race)
TERMINAL_ID="${ALIENKIND_TERMINAL_ID:-$$}"
CMD_HASH=$(printf '%s' "${TERMINAL_ID}:${COMMAND}" | shasum -a 256 | cut -d' ' -f1)
CONFIRM_FILE="${CONFIRM_DIR}/${CMD_HASH}"

# Check for existing confirmation (< 120 seconds old)
if [ -f "$CONFIRM_FILE" ]; then
  CONFIRM_TIME=$(cat "$CONFIRM_FILE" 2>/dev/null)
  NOW=$(date +%s)
  AGE=$(( NOW - CONFIRM_TIME ))
  if [ "$AGE" -lt 120 ]; then
    # Confirmed — allow and clean up
    rm -f "$CONFIRM_FILE"
    exit 0
  else
    # Stale confirmation — remove and re-gate
    rm -f "$CONFIRM_FILE"
  fi
fi

# --- Pattern detection ---
# All detection uses bash [[ =~ ]] to avoid echo|grep pipe issues with special characters.
# Extraction (grep -o) uses printf to avoid echo's escape sequence interpretation.
MATCHED=""
BLAST_RADIUS=""

# Case-insensitive matching for bash regex
shopt -s nocasematch

# DELETE FROM (any form — the specific WHERE doesn't matter, human should see it)
if [[ "$COMMAND" =~ DELETE[[:space:]]+FROM ]]; then
  MATCHED="SQL DELETE"
  TABLE=$(printf '%s\n' "$COMMAND" | grep -oiE 'DELETE[[:space:]]+FROM[[:space:]]+[a-zA-Z_]+' | head -1)
  BLAST_RADIUS="Deletes rows from database. Statement: ${TABLE}"
fi

# UPDATE without WHERE (bulk update — very dangerous)
if [[ "$COMMAND" =~ UPDATE[[:space:]]+[a-zA-Z_]+[[:space:]]+SET ]] && ! [[ "$COMMAND" =~ WHERE ]]; then
  MATCHED="SQL UPDATE without WHERE"
  TABLE=$(printf '%s\n' "$COMMAND" | grep -oiE 'UPDATE[[:space:]]+[a-zA-Z_]+' | head -1)
  BLAST_RADIUS="Updates ALL rows in table (no WHERE clause). Statement: ${TABLE}"
fi

# Supabase REST API destructive calls
if [[ "$COMMAND" =~ curl.*-X[[:space:]]*(DELETE|PATCH|PUT).*supabase ]]; then
  METHOD=$(printf '%s\n' "$COMMAND" | grep -oiE -- '-X[[:space:]]*(DELETE|PATCH|PUT)' | head -1)
  MATCHED="Supabase REST API ${METHOD}"
  BLAST_RADIUS="Direct HTTP ${METHOD} against Supabase. Could modify or delete production data."
fi

# .delete() against Supabase in inline scripts
if [[ "$COMMAND" =~ \.delete\(\) ]] && [[ "$COMMAND" =~ supabase|from\( ]]; then
  MATCHED="Supabase .delete() call"
  BLAST_RADIUS="Programmatic delete against Supabase table via client library."
fi

# Supabase CLI destructive commands
if [[ "$COMMAND" =~ supabase[[:space:]]+db[[:space:]]+(reset|push[[:space:]]+--force) ]]; then
  MATCHED="Supabase CLI destructive"
  BLAST_RADIUS="Resets or force-pushes database schema. Can destroy data."
fi

# Raw psql connection — allow read-only, gate destructive
# Store pattern in variable to avoid bash parser issues with special chars in [[ =~ ]]
PSQL_PIPE_PAT='[;&|][[:space:]]*psql[[:space:]]'
if [[ "$COMMAND" =~ ^[[:space:]]*psql[[:space:]] ]] || [[ "$COMMAND" =~ $PSQL_PIPE_PAT ]]; then
  # FAST PATH: check if psql command contains ANY destructive SQL keywords.
  # If none found, it's read-only (SELECT, \d, \l, SHOW, EXPLAIN, pg_*) — allow immediately.
  # Reading data cannot destroy data — no double-confirm needed.
  if [[ "$COMMAND" =~ INSERT[[:space:]] ]] || [[ "$COMMAND" =~ UPDATE[[:space:]].*SET ]] || \
     [[ "$COMMAND" =~ DELETE[[:space:]]+FROM ]] || [[ "$COMMAND" =~ DROP[[:space:]] ]] || \
     [[ "$COMMAND" =~ ALTER[[:space:]] ]] || [[ "$COMMAND" =~ TRUNCATE ]] || \
     [[ "$COMMAND" =~ GRANT[[:space:]] ]] || [[ "$COMMAND" =~ REVOKE[[:space:]] ]] || \
     [[ "$COMMAND" =~ COPY[[:space:]]+.*[[:space:]]+FROM ]]; then
    MATCHED="Raw psql (destructive SQL)"
    BLAST_RADIUS="Direct PostgreSQL write operation. Could modify or delete production data."
  fi
  # No destructive keywords found — read-only psql passes through without double-confirm.
fi

# Infrastructure destroy commands
if [[ "$COMMAND" =~ terraform[[:space:]]+(destroy|apply) ]] || \
   [[ "$COMMAND" =~ kubectl[[:space:]]+delete ]] || \
   [[ "$COMMAND" =~ pulumi[[:space:]]+destroy ]]; then
  MATCHED="Infrastructure destroy"
  BLAST_RADIUS="Infrastructure-level destructive operation. Can take down services and data."
fi

# Restore case sensitivity
shopt -u nocasematch

# --- Action evaluator tier check (catches novel destructive patterns regex misses) ---
# Inverted logic: only call the 7B when the command has SOME destructive signal
# but regex couldn't fully classify it. Most commands exit here with no LLM call.
if [ -z "$MATCHED" ]; then
  # Only escalate to 7B if command contains destructive-adjacent keywords
  if [[ "$COMMAND" =~ drop|truncate|destroy|purge|reset\ --hard|wipe|mkfs|rm\ -r ]]; then
    GUARD_ALIENKIND_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
    TIER=$(printf '%s' "$COMMAND" | node -e "
      const {evaluateAction}=require('${GUARD_ALIENKIND_DIR}/scripts/lib/action-evaluator.ts');
      let cmd='';process.stdin.on('data',c=>cmd+=c);process.stdin.on('end',async()=>{
        try{const r=await evaluateAction({type:'bash_command',target:'local',content:cmd.slice(0,500)});
        process.stdout.write(r.tier);}catch{process.stdout.write('T1');}
      });
    " 2>/dev/null)
    if [ "$TIER" = "T3" ]; then
      MATCHED="Action evaluator: irreversible write"
      BLAST_RADIUS="The action evaluator classified this as T3 (irreversible write). Review before proceeding."
    fi
  fi
  # No match from regex or 7B — safe to proceed
  [ -z "$MATCHED" ] && exit 0
fi

# --- Pattern matched: block and explain ---
# Write confirmation file so retry within 2 min passes
date +%s > "$CONFIRM_FILE"

# Display command safely (truncate for readability, use printf to avoid echo issues)
DISPLAY_CMD="$COMMAND"
if [ ${#DISPLAY_CMD} -gt 500 ]; then
  DISPLAY_CMD="${DISPLAY_CMD:0:500}..."
fi

echo "" >&2
echo "============================================" >&2
echo "  DATA GUARD — Confirmation Required" >&2
echo "============================================" >&2
echo "" >&2
echo "  Type:   ${MATCHED}" >&2
echo "  Blast:  ${BLAST_RADIUS}" >&2
echo "" >&2
echo "  Command:" >&2
printf '  %s\n' "$DISPLAY_CMD" >&2
echo "" >&2
echo "  This is a destructive data operation." >&2
echo "  Confirm with [HUMAN], then retry the exact" >&2
echo "  same command within 2 minutes to proceed." >&2
echo "" >&2
echo "============================================" >&2
exit 2

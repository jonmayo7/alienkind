#!/bin/bash
# PostToolUse hook: Audit all Bash commands + track verify evidence
# Logs every command Keel executes to an audit trail file.
# Also detects verification commands and categorizes them:
#   - syntax: node -c, bash -n (proves code parses, NOT that it works)
#   - test: test scripts, test runners (proves happy + failure paths)
# Both categories must be satisfied for full VERIFY compliance.

ALIENKIND_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
AUDIT_LOG="${ALIENKIND_DIR}/logs/audit.log"
mkdir -p "$(dirname "$AUDIT_LOG")"

# Read tool input from stdin
INPUT=$(cat)

# Find jq
JQ=$(which jq 2>/dev/null || echo "/opt/homebrew/bin/jq")

COMMAND=$(printf '%s' "$INPUT" | $JQ -r '.tool_input.command // .input.command // "unknown"' 2>/dev/null)
TOOL=$(printf '%s' "$INPUT" | $JQ -r '.tool_name // .name // "unknown"' 2>/dev/null)
SESSION_ID=$(printf '%s' "$INPUT" | $JQ -r '.session_id // empty' 2>/dev/null)

# Log it
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] [${TOOL}] ${COMMAND}" >> "$AUDIT_LOG"

# --- Build cycle: detect and categorize verification commands ---
if [ -n "$SESSION_ID" ]; then
  TRACK_FILE="/tmp/alienkind-build-cycle-${ALIENKIND_TERMINAL_ID:-${SESSION_ID}}.json"

  if [ -f "$TRACK_FILE" ]; then
    VERIFY_TYPE=""

    # All detection uses bash [[ =~ ]] to avoid echo|grep pipe issues with special characters.

    # Syntax checks — proves code parses, not that it works
    if [[ "$COMMAND" =~ node[[:space:]]-c[[:space:]] ]]; then
      VERIFY_TYPE="syntax"
    elif [[ "$COMMAND" =~ bash[[:space:]]-n[[:space:]] ]]; then
      VERIFY_TYPE="syntax"
    elif [[ "$COMMAND" =~ (npx[[:space:]])?tsc[[:space:]]--noEmit ]]; then
      VERIFY_TYPE="syntax"
    fi

    # Test execution — proves happy + failure paths
    # Match both relative (node scripts/tests/) and absolute (node /Users/.../scripts/tests/) paths
    if [[ "$COMMAND" =~ (node|tsx|npx[[:space:]]tsx|bash)[[:space:]](${ALIENKIND_DIR}/)?scripts/tests/ ]]; then
      VERIFY_TYPE="test"
    elif [[ "$COMMAND" =~ npm[[:space:]]test|npx[[:space:]]jest|npx[[:space:]]vitest|pytest|cargo[[:space:]]test|go[[:space:]]test ]]; then
      VERIFY_TYPE="test"
    elif [[ "$COMMAND" =~ \|[[:space:]]*node[[:space:]].*build-cycle ]]; then
      VERIFY_TYPE="test"
    elif [[ "$COMMAND" =~ test.*build-cycle|test.*check-wiring|Test[[:space:]][0-9] ]]; then
      VERIFY_TYPE="test"
    fi

    # Flow integration tests — more specific than "test", overrides if matched
    if [[ "$COMMAND" =~ (node|tsx|npx[[:space:]]tsx)[[:space:]](${ALIENKIND_DIR}/)?scripts/tests/test-.*-flow ]]; then
      VERIFY_TYPE="flow"
    fi

    if [ -n "$VERIFY_TYPE" ]; then
      if [ "$VERIFY_TYPE" = "syntax" ]; then
        UPDATED=$(cat "$TRACK_FILE" | $JQ '.verifyEvidence.syntax = true' 2>/dev/null)
      elif [ "$VERIFY_TYPE" = "test" ]; then
        UPDATED=$(cat "$TRACK_FILE" | $JQ '.verifyEvidence.test = true' 2>/dev/null)
      elif [ "$VERIFY_TYPE" = "flow" ]; then
        # Flow tests count as both flow AND test evidence (superset)
        UPDATED=$(cat "$TRACK_FILE" | $JQ '.verifyEvidence.flow = true | .verifyEvidence.test = true' 2>/dev/null)
      fi
      if [ -n "$UPDATED" ]; then
        # Also clear forward-look issues — verification means issues were addressed
        UPDATED=$(echo "$UPDATED" | $JQ 'del(.forwardLookIssues) | del(.forwardLookCommit)' 2>/dev/null || echo "$UPDATED")
        echo "$UPDATED" > "$TRACK_FILE"
      fi
    fi
  fi
fi

# --- Date/time evidence tracking ---
# When `date` is called, record the timestamp so time-guard.ts can verify
# that timestamps written to memory files are based on an actual time check.
if [ -n "$SESSION_ID" ] && [ -f "$TRACK_FILE" ]; then
  if [[ "$COMMAND" =~ (^|[;\&\|][[:space:]]*)date([[:space:]]|$) ]]; then
    UPDATED=$(cat "$TRACK_FILE" | $JQ --arg ts "$(date +%s)" '.dateEvidence = ($ts | tonumber)' 2>/dev/null)
    if [ -n "$UPDATED" ]; then
      echo "$UPDATED" > "$TRACK_FILE"
    fi
  fi
fi

# --- Service status evidence tracking ---
# When `launchctl list` is called, record the timestamp so verification-guard.ts
# can verify that service status claims are based on an actual check.
if [ -n "$SESSION_ID" ] && [ -f "$TRACK_FILE" ]; then
  if [[ "$COMMAND" =~ launchctl[[:space:]](list|print) ]]; then
    UPDATED=$(cat "$TRACK_FILE" | $JQ --arg ts "$(date +%s)" '.serviceEvidence = ($ts | tonumber)' 2>/dev/null)
    if [ -n "$UPDATED" ]; then
      echo "$UPDATED" > "$TRACK_FILE"
    fi
  fi
fi

# --- Calendar evidence tracking ---
# When google-calendar.ts is called, record the timestamp so verification-guard.ts
# can verify that schedule claims are based on an actual calendar check.
if [ -n "$SESSION_ID" ] && [ -f "$TRACK_FILE" ]; then
  if [[ "$COMMAND" =~ google-calendar ]]; then
    UPDATED=$(cat "$TRACK_FILE" | $JQ --arg ts "$(date +%s)" '.calendarEvidence = ($ts | tonumber)' 2>/dev/null)
    if [ -n "$UPDATED" ]; then
      echo "$UPDATED" > "$TRACK_FILE"
    fi
  fi
fi

# --- Post-commit cleanup 2026-04-10 ---
# When git commit succeeds, clear codeFiles[] and reset verifyEvidence in the
# tracking file. Bug fix: previously codeFiles[] accumulated across the whole
# session and was never cleared, so 4 commits deep every new commit required
# re-verifying files that were already in main. The commit gate wouldn't
# recognize that the previously-tracked files had been integrated. This
# forced manual re-runs of test-resource-guardian before every commit just
# to reset the verify flag, even though nothing about those files had
# changed. Fixed by: after any git commit that actually advances HEAD within
# the last 10 seconds, clear the tracking state for a clean slate on the
# next round of edits.
if [ -n "$SESSION_ID" ] && [ -f "$TRACK_FILE" ]; then
  if [[ "$COMMAND" =~ git[[:space:]]+commit ]]; then
    # Check if HEAD advanced recently (within last 10 seconds)
    if command -v git >/dev/null 2>&1; then
      LAST_COMMIT_TS=$(cd "$ALIENKIND_DIR" 2>/dev/null && git log -1 --format=%ct 2>/dev/null)
      NOW_TS=$(date +%s)
      if [ -n "$LAST_COMMIT_TS" ] && [ "$((NOW_TS - LAST_COMMIT_TS))" -lt 10 ]; then
        # Clear codeFiles, integrateDocs, and reset verifyEvidence. Leave
        # filesRead intact (those are session context, not per-commit state).
        UPDATED=$(cat "$TRACK_FILE" | $JQ '.codeFiles = [] | .integrateDocs = [] | .verifyEvidence = {syntax: false, test: false, flow: false} | del(.forwardLookIssues) | del(.forwardLookCommit)' 2>/dev/null)
        if [ -n "$UPDATED" ]; then
          echo "$UPDATED" > "$TRACK_FILE"
        fi
      fi
    fi
  fi
fi

# --- Mycelium: update activity for significant operations ---
OPERATION=""
if [[ "$COMMAND" =~ git[[:space:]]commit ]]; then
  OPERATION="committing"
elif [[ "$COMMAND" =~ git[[:space:]]push ]]; then
  OPERATION="pushing"
elif [[ "$COMMAND" =~ git[[:space:]](checkout|switch)[[:space:]] ]]; then
  OPERATION="switching branch"
elif [[ "$COMMAND" =~ git[[:space:]](merge|rebase|cherry-pick) ]]; then
  OPERATION="merging"
elif [[ "$COMMAND" =~ (node|tsx|npx[[:space:]]tsx|bash)[[:space:]](${ALIENKIND_DIR}/)?scripts/tests/ ]]; then
  OPERATION="running tests"
elif [[ "$COMMAND" =~ npm[[:space:]]test|npx[[:space:]]jest|npx[[:space:]]vitest ]]; then
  OPERATION="running tests"
elif [[ "$COMMAND" =~ npm[[:space:]]install|npm[[:space:]]ci|pnpm[[:space:]]install|yarn[[:space:]]install ]]; then
  OPERATION="installing deps"
elif [[ "$COMMAND" =~ npm[[:space:]]run[[:space:]]build|npx[[:space:]]next[[:space:]]build|npx[[:space:]]tsc ]]; then
  OPERATION="building"
elif [[ "$COMMAND" =~ launchctl[[:space:]](load|bootstrap|kickstart) ]]; then
  OPERATION="deploying service"
elif [[ "$COMMAND" =~ psql|supabase[[:space:]](db|migration) ]]; then
  OPERATION="database work"
elif [[ "$COMMAND" =~ docker[[:space:]](run|compose|build) ]]; then
  OPERATION="docker work"
elif [[ "$COMMAND" =~ swift[[:space:]]build|xcodebuild|swiftc ]]; then
  OPERATION="swift build"
elif [[ "$COMMAND" =~ python3?[[:space:]]|pip[[:space:]]install ]]; then
  OPERATION="python work"
fi

if [ -n "$OPERATION" ]; then
  PARENT_PID=$(printf '%s' "$INPUT" | $JQ -r '.parent_pid // empty' 2>/dev/null)
  MY_PID=${PARENT_PID:-$$}
  node -e "
    try {
      const m = require('${ALIENKIND_DIR}/scripts/lib/mycelium.ts');
      m.updateActivity('terminal-${MY_PID}', '${OPERATION}', ${MY_PID});
    } catch {}
  " 2>/dev/null &
fi

# Exit 0 — don't block, just observe
exit 0

#!/bin/bash
# Stop hook: Enforce BUILD CYCLE compliance.
# Fires when Claude finishes responding. Checks that the full
# READ → WRITE → ACT → VERIFY → INTEGRATE protocol was followed.
#
# Two enforcement layers:
#   1. Git diff: if code changed in git, docs must follow (catches across-session drift)
#   2. Tracking file: if build-cycle.ts tracked code edits this turn, check completion
#
# This hook enforces INTEGRATE. The PostToolUse build-cycle.ts hook
# enforces awareness of remaining steps during the work.

KEEL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# --- Layer 1: Git-based doc drift detection ---
# Check if any scripts, config, or hook files are modified in git
MODIFIED=$(git -C "$KEEL_DIR" diff --name-only 2>/dev/null | grep -E '^(scripts/|config/|\.claude/)' | grep -v 'WIRING_MANIFEST' | grep -v 'BUILD_LOG')
STAGED=$(git -C "$KEEL_DIR" diff --cached --name-only 2>/dev/null | grep -E '^(scripts/|config/|\.claude/)' | grep -v 'WIRING_MANIFEST' | grep -v 'BUILD_LOG')

CHANGED_FILES="${MODIFIED}${STAGED}"

if [ -n "$CHANGED_FILES" ]; then
  WARNINGS=""

  # Check if wiring manifest was updated
  MANIFEST_CHANGED=$(git -C "$KEEL_DIR" diff --name-only 2>/dev/null | grep 'WIRING_MANIFEST')
  MANIFEST_STAGED=$(git -C "$KEEL_DIR" diff --cached --name-only 2>/dev/null | grep 'WIRING_MANIFEST')

  if [ -z "$MANIFEST_CHANGED" ] && [ -z "$MANIFEST_STAGED" ]; then
    # Check if there are actually new file paths that need documenting
    CODE_DIFF=$(git -C "$KEEL_DIR" diff -- '*.ts' 2>/dev/null | grep '^+' | grep -v '^+++')
    UNDOC_PATHS=""
    MANIFEST_FILE="$KEEL_DIR/config/WIRING_MANIFEST.md"
    if [ -n "$CODE_DIFF" ] && [ -f "$MANIFEST_FILE" ]; then
      for NP in $(printf '%s\n' "$CODE_DIFF" | grep -oE 'logs/[a-zA-Z0-9_-]+\.json' | sort -u); do
        if ! grep -q "$NP" "$MANIFEST_FILE" 2>/dev/null; then
          UNDOC_PATHS="${UNDOC_PATHS} ${NP}"
        fi
      done
      for NP in $(printf '%s\n' "$CODE_DIFF" | grep -oE 'memory/[a-zA-Z0-9_-]+\.json' | sort -u); do
        if ! grep -q "$NP" "$MANIFEST_FILE" 2>/dev/null; then
          UNDOC_PATHS="${UNDOC_PATHS} ${NP}"
        fi
      done
    fi
    if [ -n "$UNDOC_PATHS" ]; then
      WARNINGS="${WARNINGS}\n   → WIRING_MANIFEST.md not updated. Undocumented paths:${UNDOC_PATHS}"
    else
      WARNINGS="${WARNINGS}\n   → WIRING_MANIFEST.md not updated. Every write needs a reader."
    fi
  fi

  # Check if today's daily file was updated (source of truth for build documentation)
  TODAY_DATE=$(TZ='${TZ:-UTC}' date '+%Y-%m-%d')
  DAILY_CHANGED=$(git -C "$KEEL_DIR" diff --name-only 2>/dev/null | grep "memory/daily/${TODAY_DATE}.md")
  DAILY_STAGED=$(git -C "$KEEL_DIR" diff --cached --name-only 2>/dev/null | grep "memory/daily/${TODAY_DATE}.md")

  if [ -z "$DAILY_CHANGED" ] && [ -z "$DAILY_STAGED" ]; then
    WARNINGS="${WARNINGS}\n   → Today's daily file not updated. Document what was built in memory/daily/${TODAY_DATE}.md."
  fi

  if [ -n "$WARNINGS" ]; then
    echo ""
    echo "BUILD CYCLE — INTEGRATE CHECK (code changed, docs may be stale):"
    echo "   Modified: $(echo "$CHANGED_FILES" | tr '\n' ', ' | sed 's/,$//')"
    echo -e "$WARNINGS"
    echo "   Protocol: READ → WRITE → ACT → VERIFY → INTEGRATE"
    echo ""
  fi
fi

# --- Layer 2: Session tracking file audit ---
# Read the tracking file written by build-cycle.ts (PostToolUse hook)
# This catches within-turn compliance, not just across-session git drift

# Try to find the tracking file for this session
INPUT=$(cat)
JQ=$(which jq 2>/dev/null || echo "/opt/homebrew/bin/jq")
SESSION_ID=$(printf '%s' "$INPUT" | $JQ -r '.session_id // empty' 2>/dev/null)

if [ -n "$SESSION_ID" ]; then
  TRACK_FILE="/tmp/keel-build-cycle-${SESSION_ID}.json"

  if [ -f "$TRACK_FILE" ]; then
    CODE_COUNT=$(echo "$(cat "$TRACK_FILE")" | $JQ -r '.codeFiles | length' 2>/dev/null)

    if [ "$CODE_COUNT" != "0" ] && [ "$CODE_COUNT" != "null" ] && [ -n "$CODE_COUNT" ]; then
      CODE_FILES=$(cat "$TRACK_FILE" | $JQ -r '.codeFiles[]' 2>/dev/null | tr '\n' ', ' | sed 's/,$//')

      # --- 5-Stage Build Cycle Audit ---
      READ_MANIFEST=$(echo "$(cat "$TRACK_FILE")" | $JQ -r '.readEvidence.wiringManifest // false' 2>/dev/null)
      VERIFY_SYNTAX=$(echo "$(cat "$TRACK_FILE")" | $JQ -r '.verifyEvidence.syntax // false' 2>/dev/null)
      VERIFY_TEST=$(echo "$(cat "$TRACK_FILE")" | $JQ -r '.verifyEvidence.test // false' 2>/dev/null)
      INTEGRATE_DOCS=$(echo "$(cat "$TRACK_FILE")" | $JQ -r '.integrateDocs // [] | join(", ")' 2>/dev/null)

      # Backward compat: old boolean format
      VERIFY_TYPE=$(echo "$(cat "$TRACK_FILE")" | $JQ -r '.verifyEvidence | type' 2>/dev/null)
      if [ "$VERIFY_TYPE" = "boolean" ]; then
        LEGACY_VAL=$(echo "$(cat "$TRACK_FILE")" | $JQ -r '.verifyEvidence' 2>/dev/null)
        if [ "$LEGACY_VAL" = "true" ]; then
          VERIFY_SYNTAX="true"
          VERIFY_TEST="true"
        fi
      fi

      HAS_GAPS=""

      # Check each stage
      if [ "$READ_MANIFEST" != "true" ]; then HAS_GAPS="yes"; fi
      if [ "$VERIFY_SYNTAX" != "true" ]; then HAS_GAPS="yes"; fi
      if [ "$VERIFY_TEST" != "true" ]; then HAS_GAPS="yes"; fi
      if ! [[ "$INTEGRATE_DOCS" =~ memory/daily/ ]]; then HAS_GAPS="yes"; fi

      if [ -n "$HAS_GAPS" ]; then
        echo ""
        echo "BUILD CYCLE — Session Audit (${CODE_COUNT} code file(s): ${CODE_FILES})"

        # READ
        if [ "$READ_MANIFEST" = "true" ]; then
          echo "   READ:      ok — WIRING_MANIFEST consulted"
        else
          echo "   READ:      gap — WIRING_MANIFEST not read this session"
        fi

        # WRITE
        echo "   WRITE:     ok — ${CODE_COUNT} file(s) tracked"

        # ACT (implied by INTEGRATE)
        echo "   ACT:       (covered by INTEGRATE check)"

        # VERIFY
        if [ "$VERIFY_SYNTAX" = "true" ] && [ "$VERIFY_TEST" = "true" ]; then
          echo "   VERIFY:    ok — syntax + tests passed"
        elif [ "$VERIFY_SYNTAX" = "true" ]; then
          echo "   VERIFY:    gap — syntax checked, NO functional tests"
        else
          echo "   VERIFY:    gap — no verification evidence"
        fi

        # INTEGRATE
        if [ -n "$INTEGRATE_DOCS" ] && [[ "$INTEGRATE_DOCS" =~ memory/daily/ ]]; then
          echo "   INTEGRATE: ok — docs updated (${INTEGRATE_DOCS})"
        elif [ -n "$INTEGRATE_DOCS" ]; then
          echo "   INTEGRATE: partial — updated: ${INTEGRATE_DOCS} (missing daily file)"
        else
          echo "   INTEGRATE: gap — no documentation updated"
        fi

        echo ""
      fi
    fi
  fi
fi

exit 0

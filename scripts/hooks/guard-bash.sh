#!/bin/bash
# PreToolUse hook: Block destructive Bash commands + enforce build cycle on commits
# Immune system layer — prevents accidental damage AND enforces VERIFY + INTEGRATE before commit
#
# Commit gates (all must pass for production code changes):
#   1. VERIFY: syntax check evidence
#   2. VERIFY: functional test evidence
#   3. INTEGRATE: today's daily file updated (document what was built)
#   4. INTEGRATE: WIRING_MANIFEST read (consulted for data flow impact)
#   5. WIRING: no WRITE-ONLY gaps in manifest
#   6. WIRING: new inter-module file paths in diff must appear in manifest

# Dynamic repo root — no hardcoded paths
GUARD_KEEL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

INPUT=$(cat)
JQ=$(which jq 2>/dev/null || echo "/opt/homebrew/bin/jq")
COMMAND=$(printf '%s' "$INPUT" | $JQ -r '.tool_input.command // ""' 2>/dev/null)
SESSION_ID=$(printf '%s' "$INPUT" | $JQ -r '.session_id // empty' 2>/dev/null)

# --- Fail-closed: if INPUT is non-empty but COMMAND is empty, jq parse failed ---
if [ -z "$COMMAND" ] && [ -n "$INPUT" ]; then
  echo "BLOCKED: unparseable hook input — failing closed (guard-bash)" >&2
  exit 2
fi

# --- Layer 1: Destructive command blocking ---
BLOCKED_PATTERNS=(
  'rm -rf /$'
  'rm -rf / '
  'rm -rf ~$'
  'rm -rf \$HOME$'
  "drop table"
  "drop database"
  "truncate table"
  "DELETE FROM.*WHERE 1"
  "git reset --hard"
  "git push.*--force.*main"
  "git push.*--force.*master"
  "format disk"
  "mkfs"
  "dd if="
)

# All detection uses bash [[ =~ ]] to avoid echo|grep pipe issues with special characters.
shopt -s nocasematch
for pattern in "${BLOCKED_PATTERNS[@]}"; do
  if [[ "$COMMAND" =~ $pattern ]]; then
    echo "BLOCKED by immune system: matches destructive pattern '${pattern}'" >&2
    exit 2
  fi
done
shopt -u nocasematch

# --- Layer 1.5: DM session message gate — blocks direct send-telegram/discord-send ---
# Listener-spawned DM sessions have KEEL_DM_SESSION=1 in their env.
# The listener relay is the canonical delivery path — direct calls cause double-posting.
if [ "$KEEL_DM_SESSION" = "1" ]; then
  if [[ "$COMMAND" =~ send-telegram|discord-send ]]; then
    echo "BLOCKED by DM session gate: direct message sending disabled in listener-spawned sessions." >&2
    echo "The listener automatically relays your text output to the user. Do not call send-telegram or discord-send directly." >&2
    exit 2
  fi
fi

# --- Layer 1.55: Session mode enforcement (Containment Fields) ---
# KEEL_SESSION_MODE constrains what a session can do structurally.
# operator: can send externally, cannot write identity/memory state files
# builder: code files only, no external messaging, no identity/personal data access
if [ -n "$KEEL_SESSION_MODE" ]; then
  # --- Identity/state file protection (operator + builder) ---
  # Block ANY command that references identity/state files in non-analyst modes.
  # Layer 1: Regex fast path for obvious reads (git diff/log/show, grep).
  # Layer 2: 7B semantic check for commands that pass regex but might be creative bypasses.
  IDENTITY_PATHS='identity/(character|commitments|orientation|harness|user)\.md|memory/structured-state\.json|memory/session-state\.md|CLAUDE\.md'
  PROTECTED_PATHS='identity/(character|commitments|orientation|harness|user)\.md|memory/structured-state\.json|memory/session-state\.md|CLAUDE\.md|config/daemon-jobs\.ts|config/policies/'
  if [ "$KEEL_SESSION_MODE" = "operator" ] || [ "$KEEL_SESSION_MODE" = "builder" ]; then
    MATCHED_PATH=""
    if [[ "$COMMAND" =~ $PROTECTED_PATHS ]]; then
      MATCHED_PATH=$(printf '%s\n' "$COMMAND" | grep -oE "$PROTECTED_PATHS" | head -1)
    fi
    if [ -n "$MATCHED_PATH" ]; then
      # Fast path: obvious read-only operations pass immediately
      # BUT: if the command contains redirects (>, >>, tee), it's a write regardless of prefix
      HAS_REDIRECT=""
      if [[ "$COMMAND" =~ '>'[[:space:]]|'>>'[[:space:]]|[^[:alnum:]]tee[^[:alnum:]]|[^[:alnum:]]cp[^[:alnum:]]|[^[:alnum:]]mv[^[:alnum:]]|[^[:alnum:]]rm[^[:alnum:]] ]]; then
        HAS_REDIRECT="1"
      fi
      if [ -z "$HAS_REDIRECT" ] && [[ "$COMMAND" =~ ^[[:space:]]*(git[[:space:]]+(diff|log|show|blame)|grep[[:space:]]|rg[[:space:]]|cat[[:space:]]) ]]; then
        : # allow reads (no redirect detected, safe prefix)
      else
        # Semantic check: classify as READ or WRITE via the dedicated classifier substrate.
        # Routes through scripts/tools/local-classify.js — single source of truth for classifier
        # body construction. Model id, port, and enable_thinking flag are owned by the wrapper;
        # this hook only constructs the prompt. See scripts/lib/models.ts CLASSIFIER_9B for the
        # role declaration and com.example.vllm-classifier.plist for the dedicated server.
        SEMANTIC_VERDICT=""
        CLASSIFIER_PROMPT="Is this command attempting to read, write, modify, copy, move, or delete the file at ${MATCHED_PATH}? Commands like cat, head, tail, wc, less, file, stat, ls, diff, grep, awk (without redirection) are READ. Commands like echo/printf with > or >>, tee, cp, mv, rm, sed -i, node -e writeFileSync, python -c open().write() are WRITE. Respond with ONLY: READ or WRITE

Command: ${COMMAND:0:500}"
        SEMANTIC_RESULT=$(printf '%s' "$CLASSIFIER_PROMPT" | node "${GUARD_KEEL_DIR}/scripts/tools/local-classify.js" --uppercase --max-tokens 10 2>/dev/null)
        # Normalize: the wrapper may return "READ\n" or "READ word" — match leading token only.
        if [[ "$SEMANTIC_RESULT" =~ ^READ ]]; then SEMANTIC_RESULT="READ";
        elif [[ "$SEMANTIC_RESULT" =~ ^WRITE ]]; then SEMANTIC_RESULT="WRITE";
        elif [ "$SEMANTIC_RESULT" = "UNAVAILABLE" ]; then SEMANTIC_RESULT="UNAVAILABLE";
        else SEMANTIC_RESULT="UNKNOWN"; fi

        if [ "$SEMANTIC_RESULT" = "READ" ]; then
          # 7B says READ — allow for operator (can read identity, not .env)
          if [ "$KEEL_SESSION_MODE" = "operator" ]; then
            # Operator can read identity files but NOT .env
            if [[ "$COMMAND" =~ \.env([^[:alnum:]]|$) ]]; then
              echo "BLOCKED by session mode: operator mode cannot access .env (7B confirmed read, but .env is restricted)." >&2
              exit 2
            fi
            : # allow read
          else
            # Builder cannot read identity or .env
            echo "BLOCKED by session mode: builder mode cannot access identity/state files (7B confirmed read, but builder has no read access)." >&2
            exit 2
          fi
        elif [ "$SEMANTIC_RESULT" = "WRITE" ]; then
          echo "BLOCKED by session mode: ${KEEL_SESSION_MODE} mode cannot modify protected files (7B confirmed write intent)." >&2
          echo "Protected path: ${MATCHED_PATH}. Requires analyst mode." >&2
          exit 2
        elif [ "$SEMANTIC_RESULT" = "UNAVAILABLE" ]; then
          # 7B unavailable — fail closed for non-analyst modes
          echo "BLOCKED by session mode: ${KEEL_SESSION_MODE} mode cannot access protected files (7B unavailable, failing closed)." >&2
          echo "Protected path: ${MATCHED_PATH}. Requires analyst mode." >&2
          exit 2
        else
          # UNKNOWN response — fail closed
          echo "BLOCKED by session mode: ${KEEL_SESSION_MODE} mode cannot modify identity/state files." >&2
          echo "Any command referencing identity files is blocked. Requires analyst mode." >&2
          exit 2
        fi
      fi
    fi
  fi
  # --- .env protection (builder mode — A7: service key extraction) ---
  if [ "$KEEL_SESSION_MODE" = "builder" ]; then
    if [[ "$COMMAND" =~ \.env([^[:alnum:]]|$) ]]; then
      echo "BLOCKED by session mode: builder mode cannot access .env (contains service keys)." >&2
      exit 2
    fi
  fi
  # --- Kill switch protection (non-analyst modes — A11) ---
  if [ "$KEEL_SESSION_MODE" = "operator" ] || [ "$KEEL_SESSION_MODE" = "builder" ]; then
    if [[ "$COMMAND" =~ /tmp/keel-kill-level|keel-kill ]]; then
      echo "BLOCKED by session mode: ${KEEL_SESSION_MODE} mode cannot modify kill switch state." >&2
      exit 2
    fi
  fi
  # --- Builder-specific restrictions ---
  if [ "$KEEL_SESSION_MODE" = "builder" ]; then
    # Builder cannot send external messages
    if [[ "$COMMAND" =~ send-telegram|discord-send|post-to-x|post-to-linkedin|send-email ]]; then
      echo "BLOCKED by session mode: builder mode cannot send external messages." >&2
      exit 2
    fi
    # Builder cannot access client/personal files
    if [[ "$COMMAND" =~ memory/synthesis/clients/ ]]; then
      echo "BLOCKED by session mode: builder mode cannot access client data." >&2
      exit 2
    fi
    # Builder cannot push if staged changes include hooks or identity (code execution vector)
    if [[ "$COMMAND" =~ git[[:space:]]push ]]; then
      HOOK_CHANGES=$(git diff --cached --name-only 2>/dev/null | grep -E 'scripts/hooks/|identity/|CLAUDE\.md|\.claude/' || true)
      if [ -n "$HOOK_CHANGES" ]; then
        echo "BLOCKED by session mode: builder mode cannot push commits that modify hooks or identity." >&2
        echo "Modified protected files: ${HOOK_CHANGES}" >&2
        echo "Requires analyst mode (interactive terminal with [HUMAN]) to push these changes." >&2
        exit 2
      fi
    fi
  fi
fi

# --- Layer 1.6: Email safety gate (BLOCKING) ---
# Catches ALL email-sending paths that bypass send-email.ts safety stack:
#   - Direct Gmail API calls (curl to messages/send)
#   - google-gmail.ts CLI send/reply (has zero safety gates — no kill switch,
#     no action evaluator, no output guard, no sender guard)
# Always blocks on first attempt. Retry within 2 minutes to confirm.
# send-email.ts is the canonical path — it enforces sender guard (keel default,
# --as-[human_first] required for [HUMAN]), kill switch, action evaluator, output guard, and auto-CC.
if [[ "$COMMAND" =~ gmail.*messages/send|gmail.*v1/users/me/messages|google-gmail\.ts.*(send|reply) ]]; then
  EMAIL_TERMINAL_ID="${KEEL_TERMINAL_ID:-$$}"
  HASH=$(printf '%s' "${EMAIL_TERMINAL_ID}:${COMMAND}" | shasum | cut -d' ' -f1)
  CONFIRM_FILE="/tmp/keel-email-api-confirm-${HASH}"

  if [ -f "$CONFIRM_FILE" ]; then
    CONFIRM_AGE=$(( $(date +%s) - $(stat -f%m "$CONFIRM_FILE" 2>/dev/null || echo 0) ))
    if [ "$CONFIRM_AGE" -lt 120 ]; then
      rm -f "$CONFIRM_FILE"
      # Confirmed — pass through but still enforce quality
      # Check for special characters in the command (em dash, curly quotes, etc.)
      if printf '%s' "$COMMAND" | grep -qP '[\x{2014}\x{2013}\x{201C}\x{201D}\x{2018}\x{2019}]' 2>/dev/null; then
        echo "" >&2
        echo "BLOCKED — Direct email contains special characters (em dashes, curly quotes)." >&2
        echo "Replace with ASCII equivalents before sending." >&2
        echo "" >&2
        exit 2
      fi
    else
      rm -f "$CONFIRM_FILE"
    fi
  else
    touch "$CONFIRM_FILE"
    echo "" >&2
    echo "╔══════════════════════════════════════════════════════════════╗" >&2
    echo "║  EMAIL SAFETY GATE — BLOCKED                               ║" >&2
    echo "╠══════════════════════════════════════════════════════════════╣" >&2
    echo "║  You are bypassing send-email.ts safety stack:             ║" >&2
    echo "║    • Sender guard (keel default, --as-[human_first] for [HUMAN])         ║" >&2
    echo "║    • Kill switch gate                                      ║" >&2
    echo "║    • Action evaluator (T4 external comms)                  ║" >&2
    echo "║    • Output guard (credential/architecture leak scan)      ║" >&2
    echo "║    • Auto-CC [HUMAN] on keel-account sends                     ║" >&2
    echo "║    • Gmail signature auto-append                           ║" >&2
    echo "║                                                            ║" >&2
    echo "║  USE: npx tsx scripts/tools/send-email.ts                  ║" >&2
    echo "║                                                            ║" >&2
    echo "║  If you must bypass: retry same command within 2 min.      ║" >&2
    echo "╚══════════════════════════════════════════════════════════════╝" >&2
    echo "" >&2
    exit 2
  fi
fi

# KEEL_DIR for Node requires (needed by Layer 1.7 + commit quality check)
# GUARD_KEEL_DIR already set at top of file

# --- Layer 1.7: Credential/exfiltration gate (7B semantic evaluation) ---
# Replaces brittle regex that was blocking our own tools (credential-check.ts name
# matched "credential" keyword). Now uses the action evaluator's 7B check.
# Known safe patterns pass instantly. Everything else gets 7B evaluation.
# Excludes git commands and War Room API calls.
if ! [[ "$COMMAND" =~ ^git[[:space:]] ]] && ! [[ "$COMMAND" =~ war-room ]]; then
  # Only check commands that touch external services
  shopt -s nocasematch
  TOUCHES_EXTERNAL=false
  if [[ "$COMMAND" =~ curl|wget|https?\.request|http\.request|\.end\(|fetch\(|sendTelegram|sendDocument|gmail|discord|webhook ]]; then
    TOUCHES_EXTERNAL=true
  fi
  shopt -u nocasematch
  if [ "$TOUCHES_EXTERNAL" = "true" ]; then
    CRED_RESULT=$(printf '%s' "$COMMAND" | node -e "
      const { checkCredentialExfiltration } = require('${GUARD_KEEL_DIR}/scripts/lib/action-evaluator.ts');
      let cmd = '';
      process.stdin.on('data', c => cmd += c);
      process.stdin.on('end', async () => {
        const r = await checkCredentialExfiltration(cmd.trim());
        if (!r.safe) { process.stderr.write(r.reason); process.exit(1); }
        process.exit(0);
      });
    " 2>&1)
    CRED_EXIT=$?
    if [ "$CRED_EXIT" -eq 1 ]; then
      echo "" >&2
      echo "╔══════════════════════════════════════════════════════════════╗" >&2
      echo "║  CREDENTIAL/EXFILTRATION GATE — HARD BLOCK                 ║" >&2
      echo "╠══════════════════════════════════════════════════════════════╣" >&2
      echo "║  7B evaluation detected potential data exfiltration:       ║" >&2
      echo "║  $CRED_RESULT  " >&2
      echo "║                                                            ║" >&2
      echo "║  Ask [HUMAN] to confirm, then retry.                           ║" >&2
      echo "╚══════════════════════════════════════════════════════════════╝" >&2
      echo "" >&2

      # Same 2-minute confirm pattern
      CRED_HASH=$(printf '%s' "$COMMAND" | shasum | cut -d' ' -f1)
      CRED_FILE="/tmp/keel-cred-confirm-${CRED_HASH}"
      if [ -f "$CRED_FILE" ]; then
        CRED_AGE=$(( $(date +%s) - $(stat -f%m "$CRED_FILE" 2>/dev/null || echo 0) ))
        if [ "$CRED_AGE" -lt 120 ]; then
          rm -f "$CRED_FILE"
          # [HUMAN] confirmed — allow through
        else
          rm -f "$CRED_FILE"
          touch "$CRED_FILE"
          exit 2
        fi
      else
      touch "$CRED_FILE"
      exit 2
    fi
  fi
fi
fi

# Layer 1.8 REMOVED — consolidated into Layer 1.7 via action-evaluator.ts.
# The action evaluator's checkCredentialExfiltration() replaces both the old
# regex Layer 1.7 AND the separate semantic-credential-check.ts Layer 1.8.

# --- Layer 2: Push safety — auto-pull before push (concurrent terminal protection) ---
if [[ "$COMMAND" =~ git[[:space:]]push ]]; then
  # Fetch latest from remote to check if we're behind
  git fetch origin 2>/dev/null
  BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ -n "$BRANCH" ]; then
    LOCAL=$(git rev-parse "$BRANCH" 2>/dev/null)
    REMOTE=$(git rev-parse "origin/$BRANCH" 2>/dev/null)
    BASE=$(git merge-base "$BRANCH" "origin/$BRANCH" 2>/dev/null)
    if [ "$LOCAL" != "$REMOTE" ] && [ "$LOCAL" = "$BASE" ]; then
      echo "" >&2
      echo "PUSH BLOCKED — Remote has new commits (likely from another terminal)." >&2
      echo "Run: git pull --rebase" >&2
      echo "Then retry the push. This prevents overwriting concurrent work." >&2
      echo "" >&2
      exit 2
    elif [ "$LOCAL" != "$REMOTE" ] && [ "$REMOTE" = "$BASE" ]; then
      # Local is ahead of remote — safe to push
      :
    elif [ "$LOCAL" != "$REMOTE" ] && [ "$LOCAL" != "$BASE" ] && [ "$REMOTE" != "$BASE" ]; then
      echo "" >&2
      echo "PUSH BLOCKED — Local and remote have diverged (both have new commits)." >&2
      echo "Run: git pull --rebase" >&2
      echo "Resolve any conflicts, then retry the push." >&2
      echo "" >&2
      exit 2
    fi
  fi
fi

# --- Layer 3: STATELESS commit-time gates (refactored 2026-04-10) ---
#
# Previously this layer read from /tmp/keel-build-cycle-*.json tracking file
# (codeFiles[], verifyEvidence, readEvidence, integrateDocs) which accumulated
# state across the session, never cleared on successful commits, and produced
# catastrophic false positives that turned every commit into a 5-15 minute
# ritual. [HUMAN] called it: "it's not enforcement, it's ritual."
#
# Replaced with stateless checks that read only from the current git state
# (staged files, staged diff). Can't accumulate drift. Can't be wrong about
# what you already committed.
#
# Kept gates (stateless, grep-based, fast):
#   - WIRING: no WRITE-ONLY gaps in manifest
#   - WIRING: new inter-module file paths must be documented
#   - DATA FLOW: Supabase tables written must have readers
#   - ACTIVATE: infra config must be live before commit (stateless rewrite
#     using `git diff --cached --name-only`)
#
# Removed gates (stateful, broken):
#   - VERIFY syntax/tests (relied on verifyEvidence that reset on every edit)
#   - VERIFY flow for autonomous files (same class of bug)
#   - INTEGRATE daily file (required daily file update for any prod code)
#   - INTEGRATE WIRING_MANIFEST read evidence (required session-scoped flag)
#
# The removed behaviors were either ritual (forced re-running the same test
# multiple times to re-set a flag) or belonged as developer responsibility
# in the READ→WRITE→VERIFY rhythm. Binary gates live here; judgment lives
# with the developer.
if [[ "$COMMAND" =~ git[[:space:]]commit ]]; then
  MANIFEST_FILE="${GUARD_KEEL_DIR}/config/WIRING_MANIFEST.md"
  STAGED_DIFF=$(git diff --cached -U0 -- '*.ts' 2>/dev/null | grep '^+' | grep -v '^+++')

  # --- Gate: WIRING completeness — no write-only gaps ---
  if [ -f "$MANIFEST_FILE" ]; then
    WRITE_ONLY=$(grep -c '| \*\*WRITE-ONLY\*\*' "$MANIFEST_FILE" 2>/dev/null)
    if [ -n "$WRITE_ONLY" ] && [ "$WRITE_ONLY" != "0" ]; then
      echo "" >&2
      echo "COMMIT BLOCKED — WIRING: ${WRITE_ONLY} write-only gap(s) in WIRING_MANIFEST.md." >&2
      echo "Every write needs a reader. Fix incomplete data flows before committing." >&2
      grep '| \*\*WRITE-ONLY\*\*' "$MANIFEST_FILE" | head -5 >&2
      echo "" >&2
      exit 2
    fi
  fi

  # --- Gate: WIRING — new inter-module file paths must be in manifest ---
  if [ -f "$MANIFEST_FILE" ] && [ -n "$STAGED_DIFF" ]; then
    UNDOCUMENTED=""
    for NEW_PATH in $(printf '%s\n' "$STAGED_DIFF" | grep -oE 'logs/[a-zA-Z0-9_-]+\.json' | sort -u); do
      if ! grep -q "$NEW_PATH" "$MANIFEST_FILE" 2>/dev/null; then
        UNDOCUMENTED="${UNDOCUMENTED} ${NEW_PATH}"
      fi
    done
    for NEW_PATH in $(printf '%s\n' "$STAGED_DIFF" | grep -oE 'memory/[a-zA-Z0-9_-]+\.json' | sort -u); do
      if ! grep -q "$NEW_PATH" "$MANIFEST_FILE" 2>/dev/null; then
        UNDOCUMENTED="${UNDOCUMENTED} ${NEW_PATH}"
      fi
    done
    if [ -n "$UNDOCUMENTED" ]; then
      echo "" >&2
      echo "COMMIT BLOCKED — WIRING: New inter-module file path(s) not in WIRING_MANIFEST.md:" >&2
      for P in $UNDOCUMENTED; do echo "   → ${P}" >&2; done
      echo "Add writer/reader documentation to config/WIRING_MANIFEST.md, then retry." >&2
      echo "" >&2
      exit 2
    fi
  fi

  # --- Gate: DATA FLOW — Supabase writes must have confirmed readers ---
  if [ -n "$STAGED_DIFF" ]; then
    NEW_WRITES=$(printf '%s\n' "$STAGED_DIFF" | grep -oE "supabase(Post|Patch)\(['\"][a-z_]+['\"]" | grep -oE "['\"][a-z_]+['\"]" | tr -d "'" | tr -d '"' | sort -u)
    if [ -n "$NEW_WRITES" ]; then
      ORPHANED=""
      for TABLE in $NEW_WRITES; do
        READER_COUNT=$(grep -rl "supabaseGet.*['\"]${TABLE}['\"]" scripts/ --include="*.ts" 2>/dev/null | grep -v tests/ | wc -l | tr -d ' ')
        READER_COUNT2=$(grep -rl "supabaseCount.*['\"]${TABLE}['\"]" scripts/ --include="*.ts" 2>/dev/null | grep -v tests/ | wc -l | tr -d ' ')
        CURL_READER=$(grep -rl "rest/v1/${TABLE}" scripts/ --include="*.sh" 2>/dev/null | wc -l | tr -d ' ')
        TOTAL=$((READER_COUNT + READER_COUNT2 + CURL_READER))
        if [ "$TOTAL" = "0" ]; then
          ORPHANED="${ORPHANED} ${TABLE}"
        fi
      done
      if [ -n "$ORPHANED" ]; then
        echo "" >&2
        echo "COMMIT BLOCKED — DATA FLOW: These Supabase tables are written but have no confirmed reader:" >&2
        for T in $ORPHANED; do echo "   → ${T}" >&2; done
        echo "Every write needs a reader. Add a reader in scripts/, or document the external consumer" >&2
        echo "in WIRING_MANIFEST.md (ground.sh, external app, [PRODUCT] dashboard, etc). Then retry." >&2
        echo "" >&2
        exit 2
      fi
    fi
  fi

  # --- Gate: TEST COVERAGE — new daemon jobs must have both test tiers ---
  # [HUMAN]'s directive (2026-04-13): "Every daemon job should have an integration
  # level test." Enforcement: when daemon-jobs.ts is staged, extract job names
  # from STAGED version, compare against COMMITTED version, find NEW jobs,
  # verify each has both a wiring test and an integration test.
  #
  # Design constraints (to avoid creating its own problems):
  #   - Only fires when daemon-jobs.ts is staged
  #   - Only checks NEW job names (not existing ones — they're already covered)
  #   - Checks for test-{name}*.ts pattern (flexible naming)
  #   - WARNING for first commit (gives time to write tests), BLOCK on second
  #   - Does NOT block auto-commit (auto-commit doesn't add new job names)
  if printf '%s\n' "$STAGED_FILES" | grep -q 'config/daemon-jobs.ts'; then
    # Extract job names from staged and committed versions
    STAGED_JOBS=$(git show :config/daemon-jobs.ts 2>/dev/null | grep -oE "name: '[^']+'" | grep -oE "'[^']+'" | tr -d "'" | sort)
    COMMITTED_JOBS=$(git show HEAD:config/daemon-jobs.ts 2>/dev/null | grep -oE "name: '[^']+'" | grep -oE "'[^']+'" | tr -d "'" | sort)

    if [ -n "$STAGED_JOBS" ] && [ -n "$COMMITTED_JOBS" ]; then
      NEW_JOBS=$(comm -23 <(echo "$STAGED_JOBS") <(echo "$COMMITTED_JOBS"))
      if [ -n "$NEW_JOBS" ]; then
        MISSING_TESTS=""
        for JOB in $NEW_JOBS; do
          # Normalize job name for test file lookup (e.g., linkedin-train-1 → linkedin-train)
          JOB_BASE=$(echo "$JOB" | sed 's/-[0-9]*$//')
          WIRING=$(ls scripts/tests/test-${JOB}*wiring*.ts scripts/tests/test-${JOB_BASE}*wiring*.ts scripts/tests/test-${JOB}.ts scripts/tests/test-${JOB_BASE}.ts 2>/dev/null | head -1)
          INTEGRATION=$(ls scripts/tests/test-${JOB}*integration*.ts scripts/tests/test-${JOB_BASE}*integration*.ts 2>/dev/null | head -1)
          if [ -z "$WIRING" ] || [ -z "$INTEGRATION" ]; then
            MISSING=""
            [ -z "$WIRING" ] && MISSING="wiring"
            [ -z "$INTEGRATION" ] && MISSING="${MISSING:+$MISSING + }integration"
            MISSING_TESTS="${MISSING_TESTS}\n   → ${JOB} (missing: ${MISSING})"
          fi
        done
        if [ -n "$MISSING_TESTS" ]; then
          echo "" >&2
          echo "COMMIT BLOCKED — TEST COVERAGE: New daemon job(s) missing required tests:" >&2
          echo -e "$MISSING_TESTS" >&2
          echo "" >&2
          echo "Every daemon job requires both:" >&2
          echo "  1. Static wiring test:  scripts/tests/test-{name}-wiring.ts" >&2
          echo "  2. Integration test:    scripts/tests/test-{name}-integration.ts" >&2
          echo "" >&2
          echo "Write both tests, verify they pass, then retry the commit." >&2
          echo "[HUMAN]'s directive: 'Everything we learn is worthless without action.'" >&2
          echo "" >&2
          exit 2
        fi
      fi
    fi
  fi

  # --- Gate: ACTIVATE — infrastructure changes must be live before commit ---
  # Uses `git diff --cached --name-only` (stateless) instead of the old
  # codeFiles[] tracking. Detects staged infra files, checks daemon start
  # time vs file mtimes.
  STAGED_FILES=$(git diff --cached --name-only 2>/dev/null)
  STAGED_INFRA=$(printf '%s\n' "$STAGED_FILES" | grep -E '(config/daemon-jobs|com\.example\..*\.plist|scripts/lib/constants\.ts$|scripts/daemon\.ts$|scripts/lib/scheduler\.ts$|scripts/lib/job-queue\.ts$|scripts/lib/session-manager\.ts$)' | grep -v 'com\.example\.studio2-' | tr '\n' ', ' | sed 's/,$//')

  if [ -n "$STAGED_INFRA" ]; then
    DAEMON_PID=$(launchctl list 2>/dev/null | grep com.example.daemon | awk '{print $1}')
    if [ -n "$DAEMON_PID" ] && [ "$DAEMON_PID" != "-" ]; then
      DAEMON_START=$(ps -p "$DAEMON_PID" -o lstart= 2>/dev/null)
      DAEMON_EPOCH=$(date -j -f "%a %b %d %T %Y" "$DAEMON_START" "+%s" 2>/dev/null || echo "0")
      LATEST_MOD=0
      for IFILE in config/daemon-jobs.ts config/com.example.*.plist; do
        if [ -f "$IFILE" ] && [[ ! "$IFILE" =~ studio2- ]]; then
          FMOD=$(stat -f%m "$IFILE" 2>/dev/null || echo "0")
          if [ "$FMOD" -gt "$LATEST_MOD" ]; then
            LATEST_MOD=$FMOD
          fi
        fi
      done
      if [ "$LATEST_MOD" -gt "$DAEMON_EPOCH" ]; then
        echo "" >&2
        echo "COMMIT BLOCKED — ACTIVATE: Infrastructure config modified but daemon not restarted." >&2
        echo "Staged infra files: ${STAGED_INFRA}" >&2
        echo "The daemon is running config from BEFORE your changes." >&2
        echo "Restart: launchctl bootout gui/501/com.example.daemon && launchctl load -F ~/Library/LaunchAgents/com.example.daemon.plist" >&2
        echo "Verify the new job runs, then retry the commit." >&2
        echo "" >&2
        exit 2
      fi
    else
      echo "" >&2
      echo "COMMIT BLOCKED — ACTIVATE: Infrastructure config modified but daemon is not running." >&2
      echo "Staged infra files: ${STAGED_INFRA}" >&2
      echo "Start the daemon and verify jobs execute before committing." >&2
      echo "" >&2
      exit 2
    fi
  fi
fi

# --- Layer 3.5: PROPAGATE gate (BLOCKING) ---
# If the staged diff introduces NEW data flows (supabasePost/Patch to tables,
# new file writes, cross-module requires), WIRING_MANIFEST must be UPDATED
# (not just read). Reading tells you what exists; updating documents what you added.
if [[ "$COMMAND" =~ git[[:space:]]commit ]]; then
  STAGED_DIFF_PROP=$(git diff --cached -U0 -- '*.ts' '*.sh' 2>/dev/null | grep '^+' | grep -v '^+++')
  if [ -n "$STAGED_DIFF_PROP" ]; then
    # Detect new data flows: supabasePost, supabasePatch, writeFileSync to logs/, sendTelegram
    HAS_NEW_FLOW=$(printf '%s\n' "$STAGED_DIFF_PROP" | grep -cE 'supabasePost|supabasePatch|writeFileSync.*logs/|sendTelegram|sendDocument|emitSignal' 2>/dev/null)
    if [ -n "$HAS_NEW_FLOW" ] && [ "$HAS_NEW_FLOW" -gt 0 ]; then
      # Check if WIRING_MANIFEST was actually MODIFIED (not just read)
      MANIFEST_STAGED=$(git diff --cached --name-only 2>/dev/null | grep 'WIRING_MANIFEST')
      MANIFEST_DIRTY=$(git diff --name-only 2>/dev/null | grep 'WIRING_MANIFEST')
      if [ -z "$MANIFEST_STAGED" ] && [ -z "$MANIFEST_DIRTY" ]; then
        echo "" >&2
        echo "COMMIT BLOCKED — PROPAGATE: New data flows detected but WIRING_MANIFEST not updated." >&2
        echo "  ${HAS_NEW_FLOW} new write(s) to Supabase/files/Telegram in staged diff." >&2
        echo "  PROPAGATE requires: update config/WIRING_MANIFEST.md with the new writer/reader pair." >&2
        echo "  Reading WIRING_MANIFEST tells you what exists. Updating it documents what you added." >&2
        echo "" >&2
        exit 2
      fi
    fi
  fi
fi

# --- Layer 3.6: Commit message quality check (Ollama 7B — advisory) ---
# After all blocking gates pass, the 7B checks if the commit message
# accurately describes the staged diff. Advisory only — warns, doesn't block.
if [[ "$COMMAND" =~ git[[:space:]]commit ]]; then
  printf '%s' "$COMMAND" | node "${GUARD_KEEL_DIR}/scripts/hooks/semantic-commit-check.ts" 2>&1 | while read -r line; do
    echo "$line" >&2
  done
fi

# --- Layer 3.7: Cross-repo migration gate (BLOCKING) ---
# When committing in [PROJECT] (or other external repos with migrations/),
# if migration files are staged, verify they've been executed against the DB
# before allowing commit. Prevents code-before-schema deployment gaps.
# Root cause fix for 2026-04-14 war room outage: image_url column referenced
# in code but migration never ran → all API calls broke.
if [[ "$COMMAND" =~ git[[:space:]]commit ]]; then
  # Detect if we're in [PROJECT]
  GIT_TOPLEVEL=$(git rev-parse --show-toplevel 2>/dev/null)
  if [[ "$GIT_TOPLEVEL" == *"[PROJECT]"* ]]; then
    STAGED_MIGRATIONS=$(git diff --cached --name-only -- 'migrations/*.sql' 2>/dev/null)
    if [ -n "$STAGED_MIGRATIONS" ]; then
      WR_MIGRATION_LOG="${GUARD_KEEL_DIR}/logs/war-room-migrations.log"
      UNEXECUTED=""
      for MIG in $STAGED_MIGRATIONS; do
        MIG_NAME=$(basename "$MIG")
        if [ ! -f "$WR_MIGRATION_LOG" ] || ! grep -qF "OK: ${MIG_NAME}" "$WR_MIGRATION_LOG"; then
          UNEXECUTED="${UNEXECUTED} ${MIG_NAME}"
        fi
      done
      if [ -n "$UNEXECUTED" ]; then
        echo "" >&2
        echo "COMMIT BLOCKED — MIGRATE: War room migration(s) staged but not executed." >&2
        echo "  Unexecuted:${UNEXECUTED}" >&2
        echo "  Run: npx tsx ${GUARD_KEEL_DIR}/scripts/war-room-migrate.ts" >&2
        echo "  Or:  psql \$WAR_ROOM_DB_URL -f migrations/<file>.sql" >&2
        echo "" >&2
        echo "  Code that references DB schema must not ship before the schema exists." >&2
        echo "  (2026-04-14: image_url column missing broke all war room API calls)" >&2
        echo "" >&2
        exit 2
      fi
    fi
  fi
fi

# --- Layer 4: invokeCommunity regression guard ---
# Friday migration (2026-03-21) eradicated all invokeCommunity usage.
# This gate blocks commits that reintroduce it in production scripts.
# invokeCommunity spawns bare Claude without identity — any production script using it
# means [HUMAN]/Keel voice is coming from a cold model, not Keel.
if [[ "$COMMAND" =~ git[[:space:]]commit ]]; then
  STAGED_TS=$(git diff --cached --name-only -- '*.ts' 2>/dev/null | grep -v tests/ | grep -v '.d.ts')
  if [ -n "$STAGED_TS" ]; then
    IC_VIOLATIONS=""
    for F in $STAGED_TS; do
      if [ "$F" = "scripts/lib/shared.ts" ]; then continue; fi
      # Check staged content (not working tree) for invokeCommunity imports from shared.ts
      STAGED_CONTENT=$(git show ":${F}" 2>/dev/null)
      if [ -n "$STAGED_CONTENT" ]; then
        if [[ "$STAGED_CONTENT" =~ invokeCommunity ]] && [[ "$STAGED_CONTENT" =~ require.*shared ]]; then
          IC_VIOLATIONS="${IC_VIOLATIONS} ${F}"
        fi
      fi
    done
    if [ -n "$IC_VIOLATIONS" ]; then
      echo "" >&2
      echo "COMMIT BLOCKED — INVOKE MIGRATION: invokeCommunity imported from shared.ts in production code." >&2
      echo "Files:${IC_VIOLATIONS}" >&2
      echo "invokeCommunity spawns bare Claude without identity. Use keelInvoke from runtime.ts instead." >&2
      echo "Migration guide: scripts/tests/test-invoke-migration.ts" >&2
      echo "" >&2
      exit 2
    fi
  fi
fi

# Allow everything else
exit 0

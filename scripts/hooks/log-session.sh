#!/bin/bash
# Stop hook: Log interactive session to Supabase sessions table.
# Fires when Claude finishes responding. Logs once per session via session_id marker.

KEEL_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

# Read hook input from stdin to extract session_id
INPUT=$(cat)
SESSION_ID=$(echo "$INPUT" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).session_id||''" 2>/dev/null)

# No session_id means no reliable dedup — skip
if [ -z "$SESSION_ID" ]; then
  exit 0
fi

SESSION_MARKER="/tmp/keel-session-logged-${SESSION_ID}"

# Only log once per session (first Stop event with this session_id)
if [ -f "$SESSION_MARKER" ]; then
  exit 0
fi

# Load env
if [ -f "$KEEL_DIR/.env" ]; then
  export $(grep -v '^#' "$KEEL_DIR/.env" | grep -v '^$' | xargs) 2>/dev/null
fi

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SERVICE_KEY" ]; then
  exit 0
fi

TODAY=$(date '+%Y-%m-%d')

# Log session (fire-and-forget)
curl -s -X POST "${SUPABASE_URL}/rest/v1/sessions" \
  -H "apikey: ${SUPABASE_SERVICE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d "{\"session_date\": \"${TODAY}\", \"session_type\": \"interactive\", \"platform\": \"claude_code\", \"summary\": \"Interactive session (auto-logged via Stop hook)\"}" \
  >/dev/null 2>&1 &

touch "$SESSION_MARKER"
exit 0

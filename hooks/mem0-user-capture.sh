#!/usr/bin/env bash
# mem0 user message capture hook for Claude Code
# Fires on UserPromptSubmit — extracts facts from what the user says.
# Runs alongside mem0-recall.sh (which searches mem0 for context).
#
# Users state preferences, corrections, decisions, and facts in prompts.
# This captures those mid-session instead of only at Stop.
set -euo pipefail

MEM0_HOST="${MEM0_HOST:-http://localhost:8888}"
MEM0_USER="${MEM0_USER:-jonathanirvin}"

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // empty' 2>/dev/null)

# Skip empty or trivial prompts
if [ -z "$PROMPT" ] || [ ${#PROMPT} -lt 30 ]; then
  exit 0
fi

# Skip slash commands
if echo "$PROMPT" | grep -qE '^\s*/[a-z]'; then
  exit 0
fi

# Skip confirmations and short responses
if echo "$PROMPT" | grep -qiE '^(yes|no|ok|sure|yeah|nah|y|n|go|do it|lgtm|ship it|looks good|approved?|thanks|thank you|cool|nice|great|perfect|sounds good)\s*[.!?]*$'; then
  exit 0
fi

# Debounce: skip if captured within last 60s
DEBOUNCE_FILE="/tmp/mem0-user-capture-last"
NOW=$(date +%s)
if [ -f "$DEBOUNCE_FILE" ]; then
  LAST=$(cat "$DEBOUNCE_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt 60 ]; then
    exit 0
  fi
fi
echo "$NOW" > "$DEBOUNCE_FILE"

# Fire-and-forget — send user message for fact extraction
PAYLOAD=$(jq -n \
  --arg msg "$(echo "$PROMPT" | head -c 2000)" \
  --arg uid "$MEM0_USER" \
  '{messages: [{role: "user", content: $msg}], user_id: $uid}')

nohup curl -s -m 30 -X POST "${MEM0_HOST}/memories" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 &

exit 0

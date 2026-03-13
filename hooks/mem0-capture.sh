#!/usr/bin/env bash
# mem0 auto-capture hook for Claude Code
# Fires on Stop — extracts the last user/assistant exchange from the
# transcript and sends it to mem0 for memory extraction.
#
# Runs the mem0 POST in the background so it doesn't block session exit.
set -euo pipefail

MEM0_HOST="${MEM0_HOST:-http://localhost:8888}"
MEM0_USER="${MEM0_USER:-jonathanirvin}"

INPUT=$(cat)

# Prevent infinite loops — skip if already in a stop hook
STOP_ACTIVE=$(echo "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$STOP_ACTIVE" = "true" ]; then
  exit 0
fi

LAST_ASSISTANT=$(echo "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)
TRANSCRIPT=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)

# Need at least the assistant message
if [ -z "$LAST_ASSISTANT" ]; then
  exit 0
fi

# Skip trivial responses (< 50 chars unlikely to contain extractable knowledge)
if [ ${#LAST_ASSISTANT} -lt 50 ]; then
  exit 0
fi

# Extract last user message from transcript JSONL
LAST_USER=""
if [ -n "$TRANSCRIPT" ] && [ -f "$TRANSCRIPT" ]; then
  LAST_USER=$(tail -200 "$TRANSCRIPT" \
    | jq -r 'select(.type == "user") | .message.content // empty' 2>/dev/null \
    | tail -1 \
    | head -c 2000)
fi

# Build messages payload — include user context if available
if [ -n "$LAST_USER" ]; then
  PAYLOAD=$(jq -n \
    --arg user "$LAST_USER" \
    --arg asst "$(echo "$LAST_ASSISTANT" | head -c 3000)" \
    --arg uid "$MEM0_USER" \
    '{messages: [{role: "user", content: $user}, {role: "assistant", content: $asst}], user_id: $uid}')
else
  PAYLOAD=$(jq -n \
    --arg asst "$(echo "$LAST_ASSISTANT" | head -c 3000)" \
    --arg uid "$MEM0_USER" \
    '{messages: [{role: "assistant", content: $asst}], user_id: $uid}')
fi

# Fire-and-forget — mem0 extraction takes 5-15s, don't block session exit
nohup curl -s -m 30 -X POST "${MEM0_HOST}/memories" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 &

exit 0

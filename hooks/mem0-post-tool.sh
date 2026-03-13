#!/usr/bin/env bash
# mem0 PostToolUse hook for Claude Code
# Dual behavior:
#   Error detected  → search mem0 for similar past errors (output to Claude)
#   Success + significant → capture to mem0 in background (silent)
set -euo pipefail

MEM0_HOST="${MEM0_HOST:-http://localhost:8888}"
MEM0_USER="${MEM0_USER:-jonathanirvin}"

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // empty' 2>/dev/null)
TOOL_INPUT=$(echo "$INPUT" | jq -c '.tool_input // {}' 2>/dev/null)
TOOL_RESULT=$(echo "$INPUT" | jq -r '.tool_response // empty' 2>/dev/null)

# Nothing to work with
if [ -z "$TOOL_RESULT" ] || [ ${#TOOL_RESULT} -lt 20 ]; then
  exit 0
fi

# --- ERROR PATH: Search mem0 for similar past errors ---
if echo "$TOOL_RESULT" | grep -qiE '(^error:|ERR!|FATAL|panic|exception|traceback|ENOENT|EPERM|EACCES|command not found|No such file|Permission denied|failed to compile|cannot find|could not resolve|segmentation fault|exit code [1-9])'; then

  # Extract first meaningful error line
  ERROR_MSG=$(echo "$TOOL_RESULT" \
    | grep -iE '(error|fail|cannot|could not|exception|traceback|ENOENT|EPERM|denied|not found)' \
    | head -1 \
    | head -c 200)

  if [ -z "$ERROR_MSG" ]; then
    ERROR_MSG=$(echo "$TOOL_RESULT" | head -1 | head -c 200)
  fi

  # Search mem0 for similar past errors (3s timeout, fail silently)
  RESPONSE=$(curl -s -m 3 -X POST "${MEM0_HOST}/search" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg q "$ERROR_MSG" --arg uid "$MEM0_USER" \
      '{query: $q, user_id: $uid}')" \
    2>/dev/null) || exit 0

  MEMORIES=$(echo "$RESPONSE" | jq -r '
    (if type == "array" then . else (.results // []) end)
    | map(select(.memory != null and .memory != "" and (.score // 0) >= 0.5))
    | sort_by(-.score)
    | unique_by(.memory | ascii_downcase | ltrimstr(" ") | rtrimstr(" "))
    | .[:3]
    | .[].memory' 2>/dev/null)

  if [ -n "$MEMORIES" ]; then
    echo "<mem0-error-context tool=\"$TOOL_NAME\">"
    echo "Past encounters with similar errors:"
    echo "$MEMORIES" | while IFS= read -r mem; do
      [ -n "$mem" ] && echo "- $mem"
    done
    echo "</mem0-error-context>"
  fi

  exit 0
fi

# --- CAPTURE PATH: Save significant tool outputs to mem0 ---

# Only capture from Bash (the tool that produces discoverable knowledge)
if [ "$TOOL_NAME" != "Bash" ]; then
  exit 0
fi

# Skip trivial outputs
if [ ${#TOOL_RESULT} -lt 100 ]; then
  exit 0
fi

# Skip read-only commands (ls, cat, git status, etc.) — no new knowledge
COMMAND=$(echo "$TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null)
if echo "$COMMAND" | grep -qE '^(ls|cat|head|tail|echo|pwd|which|type|file|wc|stat|git (status|log|diff|show|branch)|curl -s.*(GET|get)|jq)\b'; then
  exit 0
fi

# Debounce: skip if captured within last 30s
DEBOUNCE_FILE="/tmp/mem0-tool-capture-last"
NOW=$(date +%s)
if [ -f "$DEBOUNCE_FILE" ]; then
  LAST=$(cat "$DEBOUNCE_FILE" 2>/dev/null || echo 0)
  if [ $((NOW - LAST)) -lt 30 ]; then
    exit 0
  fi
fi
echo "$NOW" > "$DEBOUNCE_FILE"

# Build payload with command context
PAYLOAD=$(jq -n \
  --arg content "Command: $(echo "$COMMAND" | head -c 500)\nOutput: $(echo "$TOOL_RESULT" | head -c 2000)" \
  --arg uid "$MEM0_USER" \
  '{messages: [{role: "assistant", content: $content}], user_id: $uid}')

# Fire-and-forget
nohup curl -s -m 30 -X POST "${MEM0_HOST}/memories" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  > /dev/null 2>&1 &

exit 0

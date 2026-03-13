#!/usr/bin/env bash
# mem0 auto-recall hook for Claude Code
# Fires on UserPromptSubmit — searches mem0 for relevant memories
# and injects them as context before the agent processes the prompt.
#
# Self-hosted mem0 ignores top_k, so we enforce limits client-side.
set -euo pipefail

MEM0_HOST="${MEM0_HOST:-http://localhost:8888}"
MEM0_USER="${MEM0_USER:-jonathanirvin}"
TOP_K="${MEM0_TOP_K:-5}"
MIN_SCORE="${MEM0_MIN_SCORE:-0.5}"

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | jq -r '.user_prompt // empty' 2>/dev/null)

# Skip empty or trivial prompts
if [ -z "$PROMPT" ] || [ ${#PROMPT} -lt 10 ]; then
  exit 0
fi

# Truncate to first 300 chars for search efficiency
QUERY=$(echo "$PROMPT" | head -c 300)

# Search mem0 (3s timeout, fail silently)
RESPONSE=$(curl -s -m 3 -X POST "${MEM0_HOST}/search" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg q "$QUERY" --arg uid "$MEM0_USER" \
    '{query: $q, user_id: $uid}')" \
  2>/dev/null) || exit 0

# Filter by score, deduplicate, enforce top_k client-side
MEMORIES=$(echo "$RESPONSE" | jq -r --argjson topk "$TOP_K" --argjson min "$MIN_SCORE" '
  (if type == "array" then . else (.results // []) end)
  | map(select(.memory != null and .memory != "" and (.score // 0) >= $min))
  | sort_by(-.score)
  | unique_by(.memory | ascii_downcase | ltrimstr(" ") | rtrimstr(" "))
  | .[:$topk]
  | .[].memory' 2>/dev/null)

if [ -z "$MEMORIES" ]; then
  exit 0
fi

echo "<relevant-memories>"
echo "$MEMORIES" | while IFS= read -r mem; do
  [ -n "$mem" ] && echo "- $mem"
done
echo "</relevant-memories>"

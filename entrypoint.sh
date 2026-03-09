#!/bin/bash
set -e

# Graph store re-enabled — hyphen escaping patched in utils.py
# See: https://github.com/offendingcommit/daphne-workspace/issues/92

# Run the mem0 API server
# --workers 2: handle concurrent seed script requests
# --timeout-keep-alive 300: keep connections alive for slow LLM extraction
# --timeout-graceful-shutdown 30: allow in-flight requests to finish
# --reload only in dev (set MEM0_DEV=1 to enable)
RELOAD_FLAG=""
if [ "${MEM0_DEV:-0}" = "1" ]; then
  RELOAD_FLAG="--reload"
fi

exec uvicorn main:app \
  --host 0.0.0.0 \
  --port 8000 \
  --workers "${UVICORN_WORKERS:-2}" \
  --timeout-keep-alive "${UVICORN_KEEPALIVE:-300}" \
  --timeout-graceful-shutdown 30 \
  $RELOAD_FLAG

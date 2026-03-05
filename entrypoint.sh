#!/bin/bash
set -e

# Graph store re-enabled — hyphen escaping patched in utils.py
# See: https://github.com/offendingcommit/daphne-workspace/issues/92

# Run the mem0 API server (matching base image CMD)
exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload

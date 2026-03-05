#!/bin/bash
set -e

# Configure graph store after server is up (background)
(
  echo "[entrypoint] Waiting for mem0 API server to start..."
  for i in $(seq 1 120); do
    if python -c "
import urllib.request, urllib.error
try:
    urllib.request.urlopen('http://localhost:8000/memories')
except urllib.error.HTTPError:
    exit(0)  # server is up, got HTTP response (even 4xx = running)
except Exception:
    exit(1)
" 2>/dev/null; then
      echo "[entrypoint] Server is ready after ${i}s"
      python -c "
import urllib.request, json, os
data = json.dumps({
    'graph_store': {
        'provider': 'neo4j',
        'config': {
            'url': os.environ.get('NEO4J_URI', 'bolt://neo4j:7687'),
            'username': os.environ.get('NEO4J_USERNAME', 'neo4j'),
            'password': os.environ.get('NEO4J_PASSWORD', 'mem0graph')
        }
    }
}).encode()
req = urllib.request.Request('http://localhost:8000/configure', data=data, headers={'Content-Type': 'application/json'})
try:
    resp = urllib.request.urlopen(req)
    print(f'[entrypoint] Graph store configured: {resp.read().decode()}')
except Exception as e:
    print(f'[entrypoint] WARNING: configure failed: {e}')
"
      break
    fi
    sleep 2
  done
) &

# Run the mem0 API server (matching base image CMD)
exec uvicorn main:app --host 0.0.0.0 --port 8000 --reload

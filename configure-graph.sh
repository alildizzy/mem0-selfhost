#!/bin/bash
# Run after docker compose up to enable graph storage
# Usage: ./configure-graph.sh

echo "Waiting for mem0 API..."
for i in $(seq 1 60); do
  if curl -sf http://localhost:8888/memories > /dev/null 2>&1; then
    echo "Ready after ${i}s"
    break
  fi
  sleep 2
done

echo "Configuring graph store..."
curl -sf -X POST http://localhost:8888/configure \
  -H "Content-Type: application/json" \
  -d '{
    "graph_store": {
      "provider": "neo4j",
      "config": {
        "url": "bolt://neo4j:7687",
        "username": "neo4j",
        "password": "mem0graph"
      }
    }
  }' && echo " — Done" || echo " — Failed"

---
name: mem0-selfhost
description: Work with the self-hosted Mem0 Docker stack (start/stop, update plugin, build MCP, test API). Use when managing the local Mem0 instance, debugging memory storage, or updating the OpenClaw plugin or MCP server.
---

# mem0-selfhost Skill

Self-hosted Mem0 running at `http://localhost:8888`. Docker Compose stack on WALL-E.

## Start / Stop

```bash
cd ~/mem0-selfhost

# Start
docker compose up -d

# Stop
docker compose down

# Rebuild after code changes
docker compose build && docker compose up -d

# Check health
curl http://localhost:8888/docs  # Swagger UI
curl http://localhost:8888/memories?user_id=daphne-nightingale&limit=1
```

## Update the OpenClaw Plugin

The `openclaw-plugin/` subfolder is a copy of `~/.openclaw/openclaw-mem0/`. To sync:

```bash
cp ~/.openclaw/openclaw-mem0/{index.ts,package.json,openclaw.plugin.json} ~/mem0-selfhost/openclaw-plugin/
cd ~/mem0-selfhost
git add openclaw-plugin/
git commit --author="Daphne Nightingale <daphne@dopaminesoundlabs.com>" --no-gpg-sign -m "chore(plugin): sync from openclaw-mem0"
git push
```

## Build the MCP Server

```bash
cd ~/mem0-selfhost/mcp
npm install
npm run build
# Binary: dist/index.js
```

## Test the API

```bash
# List memories
curl "http://localhost:8888/memories?user_id=daphne-nightingale&limit=10"

# Search
curl -s -X POST http://localhost:8888/search \
  -H "Content-Type: application/json" \
  -d '{"query":"jazz music","user_id":"daphne-nightingale","limit":5}'

# Add memory
curl -s -X POST http://localhost:8888/memories \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"test fact"}],"user_id":"daphne-nightingale"}'

# Delete memory
curl -s -X DELETE "http://localhost:8888/memories/<uuid>"
```

## Logs & Debugging

```bash
# Stream logs
docker compose logs mem0 -f

# Check Haiku LLM is working (fact extraction)
# Add a memory and look for extraction in logs — should see Haiku processing

# If API is unreachable
docker compose ps  # check container status
docker compose restart mem0
```

## Known Issues

- **Neo4j disabled** — Cypher hyphen-escaping bug in upstream mem0. Don't re-enable.
- **Port 8888** — hardcoded in openclaw-mem0 plugin. Changing it requires updating both.
- **top_p + temperature conflict** — patched in `main.py`. Don't remove the `_filtered_create` wrapper.

## Commit Convention

```bash
git commit --author="Daphne Nightingale <daphne@dopaminesoundlabs.com>" --no-gpg-sign -m "type(scope): description"
```

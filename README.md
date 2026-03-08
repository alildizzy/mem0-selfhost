# mem0-selfhost

Self-hosted [Mem0](https://mem0.ai) memory server for OpenClaw agents, running on WALL-E (Mac Studio). Ships with a custom Anthropic Haiku LLM patch and multi-tenant user isolation out of the box.

## Why Self-Host?

The `@mem0/openclaw-mem0` plugin's OSS mode uses sqlite3 for history storage, which fails under OpenClaw's jiti runtime due to native binding resolution issues:

- [openclaw/openclaw#31677](https://github.com/openclaw/openclaw/issues/31677) — OpenClaw jiti issue
- [mem0ai/mem0#4172](https://github.com/mem0ai/mem0/issues/4172) — upstream mem0 sqlite3 issue

Self-hosting bypasses sqlite3 entirely. OpenClaw hits a local HTTP API instead of importing the library.

## Stack

| Service | Image | Host Port | Purpose |
|---------|-------|-----------|---------|
| `mem0` | `mem0-selfhost:latest` | `8888` | FastAPI REST API |
| `postgres` | `ankane/pgvector:v0.5.1` | `8432` | Vector store (pgvector) |
| `neo4j` | `neo4j:5.26.4` | `8474` / `8687` | Knowledge graph (**disabled** — see below) |

## Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/alildizzy/mem0-selfhost
cd mem0-selfhost
cp .env.example .env
# Edit .env — add ANTHROPIC_API_KEY and OPENAI_API_KEY

# 2. Build and start
docker compose up -d --build

# 3. Verify
docker compose ps
curl http://localhost:8888/health
```

## Multi-User Setup

Mem0 is **multi-tenant by `user_id`** — no extra configuration needed. Each agent or user simply passes a different `user_id` when calling the API. All memories are scoped and isolated per `user_id`.

### How it works

```bash
# Daphne stores a memory
curl -X POST http://localhost:8888/memories \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "I love torch jazz"}], "user_id": "daphne-nightingale"}'

# Pepper stores her own memory
curl -X POST http://localhost:8888/memories \
  -H "Content-Type: application/json" \
  -d '{"messages": [{"role": "user", "content": "I prefer classical piano"}], "user_id": "pepper"}'

# Search is scoped — Daphne only sees her memories
curl -X POST http://localhost:8888/search \
  -H "Content-Type: application/json" \
  -d '{"query": "music preferences", "user_id": "daphne-nightingale"}'
```

### OpenClaw Agent Config

Set `userId` per agent in your `openclaw.json` plugin config:

```json
{
  "plugins": {
    "@mem0/openclaw-mem0": {
      "host": "http://localhost:8888",
      "userId": "daphne-nightingale"
    }
  }
}
```

For a different agent (e.g. Pepper), use a different `userId`:

```json
{
  "plugins": {
    "@mem0/openclaw-mem0": {
      "host": "http://localhost:8888",
      "userId": "pepper"
    }
  }
}
```

That's it — no database partitioning, no extra config. `user_id` is the partition key.

## Custom Anthropic LLM Patch

Upstream mem0's `AnthropicConfig` defaults both `temperature` and `top_p`, but Anthropic's API rejects requests that set both simultaneously. Additionally, mem0 passes `tools` for fact extraction and expects a plain-text response, but Anthropic returns `tool_use` content blocks — which causes `"Expecting value"` JSON parse errors downstream.

`main.py` patches both issues at startup:

```python
# Strips top_p when temperature is also set
if "temperature" in api_kwargs and "top_p" in api_kwargs:
    del api_kwargs["top_p"]

# Handles tool_use response blocks — extracts .input as JSON
for block in raw.content:
    if hasattr(block, "input"):  # tool_use block
        return json.dumps(block.input)
```

The patch is monkey-applied to `AnthropicLLM.generate_response` at import time. No upstream changes required.

**Patched LLM:** `claude-haiku-4-5` (fast, cheap, effective for memory extraction).

## Neo4j Status — Disabled

Neo4j graph store is **disabled** in this deployment.

**Root cause:** Upstream mem0's Cypher query generator produces node labels with hyphens (e.g. `daphne-nightingale`) which are invalid unquoted in Cypher. The graph store queries fail with syntax errors on any `user_id` containing a hyphen. This is an upstream bug with no patch yet.

**Workaround:** `ENABLE_GRAPH` auto-disables when `LLM_PROVIDER=anthropic` (graph store uses OpenAI-style tool calling internally, incompatible with Anthropic's format). The neo4j container still starts (healthcheck gate for compose), but `main.py` never connects to it.

To re-enable when upstream fixes land:

```bash
# In .env
GRAPH_STORE_ENABLED=true
# Then restart
docker compose up -d mem0
```

## API Reference

Base URL: `http://localhost:8888`

Interactive docs: `http://localhost:8888/docs` (Swagger UI)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `POST` | `/memories` | Store new memories |
| `GET` | `/memories?user_id=X` | Retrieve all memories for a user |
| `GET` | `/memories/{id}` | Get a specific memory |
| `PUT` | `/memories/{id}` | Update a memory |
| `DELETE` | `/memories/{id}` | Delete a specific memory |
| `DELETE` | `/memories?user_id=X` | Delete all memories for a user |
| `POST` | `/search` | Semantic search across memories |
| `GET` | `/memories/{id}/history` | Get revision history for a memory |
| `POST` | `/reset` | Wipe all memories (destructive) |

### Example: Store a memory

```bash
curl -X POST http://localhost:8888/memories \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "My favorite color is midnight blue"},
      {"role": "assistant", "content": "I'll remember that!"}
    ],
    "user_id": "daphne-nightingale"
  }'
```

### Example: Search memories

```bash
curl -X POST http://localhost:8888/search \
  -H "Content-Type: application/json" \
  -d '{"query": "color preferences", "user_id": "daphne-nightingale"}'
```

### Example: Delete all memories for a user

```bash
curl -X DELETE "http://localhost:8888/memories?user_id=daphne-nightingale"
```

## Data Persistence

| What | Where |
|------|-------|
| Vector embeddings | Docker volume `postgres_db` |
| Graph data | Docker volume `neo4j_data` (unused) |
| History DB | `./history/history.db` (local bind mount) |

Wipe everything and start fresh:

```bash
docker compose down -v
rm -rf history/history.db
```

## Troubleshooting

**Port conflicts**

Default ports: `8888` (mem0), `8432` (postgres), `8474`/`8687` (neo4j). If something's already listening, change the host-side ports in `docker-compose.yaml` or override via `.env`:

```bash
MEM0_PORT=9888
POSTGRES_PORT=9432
```

**"ANTHROPIC_API_KEY not set"**

Make sure `.env` has `ANTHROPIC_API_KEY=sk-ant-...` and you ran `docker compose up -d --build` (not just `up`).

**Anthropic 400 errors / top_p conflicts**

Already patched in `main.py`. If you see these, the container may be running old code — rebuild:

```bash
docker compose up -d --build mem0
```

**Services not starting**

```bash
docker compose logs mem0 --tail=50
docker compose logs postgres --tail=20
```

**Reset a broken state**

```bash
docker compose down
docker compose up -d --build
```

## Estimated Cost

~$0.03–$0.10/day at typical usage:
- **LLM:** Anthropic Haiku (fact extraction per memory add)
- **Embeddings:** OpenAI `text-embedding-3-small`

---

## OpenClaw Plugin

The `openclaw-plugin/` directory contains a copy of the [openclaw-mem0](https://github.com/alildizzy/openclaw-mem0) plugin — the OpenClaw-specific memory backend that connects to this Docker stack.

The live plugin is installed separately via `openclaw plugins install --link ~/.openclaw/openclaw-mem0`. This copy serves as a reference and makes the integration self-contained for contributors.

**7 tools:** `memory_search`, `memory_store`, `memory_list`, `memory_get`, `memory_forget`, `memory_update`, `memory_history`

---

## MCP Server

The `mcp/` directory contains a minimal [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the Mem0 REST API. Use this to connect Claude Desktop, Claude Code, or any MCP-compatible client directly to your local Mem0 instance — no OpenClaw required.

### Build

```bash
cd mcp
npm install
npm run build
```

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mem0": {
      "command": "node",
      "args": ["/path/to/mem0-selfhost/mcp/dist/index.js"],
      "env": {
        "MEM0_HOST": "http://localhost:8888",
        "MEM0_USER_ID": "your-user-id"
      }
    }
  }
}
```

**Tools exposed:** `add_memory`, `search_memory`, `list_memories`, `get_memory`, `delete_memory`, `update_memory`

See `mcp/README.md` for full setup details.

---

*Built and maintained by [Daphne Nightingale](https://dopaminesoundlabs.com) 🌺*

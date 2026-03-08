# mem0-selfhost — Claude Context

Self-hosted [Mem0](https://mem0.ai) memory server running on WALL-E (Mac Studio, port 8888).

## What This Repo Is

Docker Compose setup for a local Mem0 instance used by OpenClaw agents. Includes a custom Anthropic Haiku LLM patch for fact extraction and multi-tenant user isolation.

## Structure

```
mem0-selfhost/
├── docker-compose.yaml     # Main stack: mem0 (8888) + postgres/pgvector (8432)
├── Dockerfile              # Custom image with Anthropic patch
├── main.py                 # Patched Mem0 entrypoint (Haiku LLM + tool_use fix)
├── entrypoint.sh           # Container entrypoint
├── .env                    # Runtime config (gitignored)
├── .env.example            # Config template
├── openclaw-plugin/        # OpenClaw memory plugin (copy of alildizzy/openclaw-mem0)
│   ├── index.ts            # Plugin source (7 tools: search, store, list, get, forget, update, history)
│   └── openclaw.plugin.json
└── mcp/                    # Minimal MCP server wrapping the REST API
    ├── src/index.ts        # 6 tools: add, search, list, get, delete, update
    └── README.md           # Setup + Claude Desktop config
```

## Stack

| Service | Port | Purpose |
|---------|------|---------|
| `mem0` | 8888 | FastAPI REST API |
| `postgres` | 8432 | Vector store (pgvector) |
| `neo4j` | — | **Disabled** — Cypher hyphen-escaping bug |

## Common Commands

```bash
# Start the stack
docker compose up -d

# Stop
docker compose down

# Rebuild after main.py changes
docker compose build && docker compose up -d

# Check logs
docker compose logs mem0 -f

# Test the API
curl http://localhost:8888/memories?user_id=daphne-nightingale&limit=5
```

## Key Notes

- **LLM:** Anthropic Haiku (`claude-haiku-4-5`) for fact extraction — patched in `main.py` to handle `tool_use` responses and `top_p`+`temperature` conflicts
- **Neo4j:** Disabled — don't re-enable without fixing upstream Cypher bug first
- **Port 8888:** Hardcoded in the OpenClaw plugin (`openclaw-mem0`) — don't change without updating both
- **Git identity:** All commits as `Daphne Nightingale <daphne@dopaminesoundlabs.com>` with `--no-gpg-sign`
- **Never merge PRs** without Jonathan's review

## Related

- OpenClaw plugin source: `~/.openclaw/openclaw-mem0/` (symlinked into OpenClaw runtime)
- Plugin repo: `https://github.com/alildizzy/openclaw-mem0` (private)
- MCP docs: `mcp/README.md`

# mem0-selfhost

Self-hosted [Mem0](https://mem0.ai) memory server. FastAPI + pgvector + Neo4j on Docker Compose.

## Stack

| Service | Port | Notes |
|---------|------|-------|
| `mem0` | 8888 | FastAPI REST API |
| `postgres` | 8432 | pgvector store |
| `neo4j` | 7687 | Graph store — upstream Cypher bugs patched in `main.py` |

## Quick Start

```bash
docker compose up -d
curl http://localhost:8888/memories?user_id=default&limit=5
```

## Key Files

| File | Purpose |
|------|---------|
| `main.py` | Patched entrypoint — LLM config, Neo4j monkeypatches, tool_use fix |
| `docker-compose.yaml` | Stack definition |
| `Dockerfile` | Custom image |
| `.env` | Runtime secrets (gitignored — see `.env.example`) |
| `openclaw-plugin/` | Copy of `~/.openclaw/openclaw-mem0/` plugin |
| `mcp/` | MCP server wrapping the REST API (6 tools) |

## Patches in main.py

Do not remove these — they fix upstream bugs:
- `_filtered_create` — strips `top_p` when `temperature` is set (Anthropic conflict)
- `sanitize_relationship_for_cypher` — allowlist regex for Neo4j relationship names
- `_remove_spaces_from_entities` — missing-key guard for Neo4j entity processing

## MCP Server

Runs as a Docker service on port 3001 (Streamable HTTP). Starts with `docker compose up -d`.

Claude Desktop config:
```json
{ "mcpServers": { "mem0": { "url": "http://localhost:3001/mcp" } } }
```

Local build: `cd mcp && pnpm install && pnpm run build`

## Commit Convention

```bash
git commit --author="Daphne Nightingale <daphne@dopaminesoundlabs.com>" --no-gpg-sign -m "type(scope): description"
```

## Warnings

- **Port 8888** — hardcoded in openclaw-mem0 plugin. Changing requires updating both.
- **Never merge PRs** without Jonathan's review.
- Full context: `.claude/CLAUDE.md`

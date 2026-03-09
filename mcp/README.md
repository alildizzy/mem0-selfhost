# mem0-selfhost MCP Server

MCP server (Streamable HTTP) wrapping the self-hosted Mem0 REST API.
Runs as a Docker service on port 3001 — start it with `docker compose up -d`.

## Tools

| Tool | Description |
|------|-------------|
| `add_memory` | Store a new memory for a user |
| `search_memory` | Semantic search across memories |
| `list_memories` | List all memories for a user |
| `get_memory` | Retrieve a specific memory by ID |
| `delete_memory` | Permanently delete a memory |
| `update_memory` | Update an existing memory's text |

## Endpoint

```
http://localhost:3001/mcp   # Streamable HTTP (POST + GET)
http://localhost:3001/health
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEM0_HOST` | `http://mem0:8000` | Mem0 REST API (internal Docker network) |
| `MEM0_USER_ID` | `default` | Default user ID if not specified per-call |
| `MCP_PORT` | `3001` | Port to listen on |

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mem0": {
      "url": "http://localhost:3001/mcp"
    }
  }
}
```

## Local Development (without Docker)

```bash
cd mcp
pnpm install
pnpm run build
MEM0_HOST=http://localhost:8888 node dist/index.js
```

## Requires

Mem0 Docker stack running (`docker compose up -d` from repo root).

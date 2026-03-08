# mem0-selfhost MCP Server

Minimal [Model Context Protocol](https://modelcontextprotocol.io) server that wraps the self-hosted Mem0 REST API. Lets Claude Desktop, Claude Code, or any MCP-compatible client use your local Mem0 instance directly.

## Tools

| Tool | Description |
|------|-------------|
| `add_memory` | Store a new memory for a user |
| `search_memory` | Semantic search across memories |
| `list_memories` | List all memories for a user |
| `get_memory` | Retrieve a specific memory by ID |
| `delete_memory` | Permanently delete a memory |
| `update_memory` | Update an existing memory's text |

## Setup

```bash
cd mcp
npm install
npm run build
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEM0_HOST` | `http://localhost:8888` | Mem0 REST API base URL |
| `MEM0_USER_ID` | `default` | Default user ID if not specified per-call |

## Claude Desktop Configuration

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mem0": {
      "command": "node",
      "args": ["/path/to/mem0-selfhost/mcp/dist/index.js"],
      "env": {
        "MEM0_HOST": "http://localhost:8888",
        "MEM0_USER_ID": "daphne-nightingale"
      }
    }
  }
}
```

## Claude Code (mcporter)

```bash
mcporter add mem0 --command "node /path/to/mem0-selfhost/mcp/dist/index.js" \
  --env MEM0_HOST=http://localhost:8888
```

## Requires

Mem0 Docker stack running (`docker compose up -d` from repo root). See main [README](../README.md).

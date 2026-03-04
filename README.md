# mem0-selfhost

Self-hosted Mem0 memory server for OpenClaw, running on WALL-E (Mac Studio).

## Why Self-Host?

The `@mem0/openclaw-mem0` plugin's OSS mode uses sqlite3 for history storage, which fails under OpenClaw's jiti runtime due to native binding resolution issues ([openclaw/openclaw#31677](https://github.com/openclaw/openclaw/issues/31677), [mem0ai/mem0#4172](https://github.com/mem0ai/mem0/issues/4172)). Self-hosting bypasses sqlite3 entirely — OpenClaw hits the Mem0 HTTP API instead.

## Stack

| Service | Image | Port (host) | Purpose |
|---------|-------|-------------|---------|
| mem0 | mem0-selfhost:latest | 8888 | FastAPI REST API |
| postgres | ankane/pgvector:v0.5.1 | 8432 | Vector store (pgvector) |
| neo4j | neo4j:5.26.4 | 8474 (browser), 8687 (bolt) | Knowledge graph |

## Quick Start

1. Copy `.env.example` to `.env` and add your OpenAI API key:
   ```bash
   cp .env.example .env
   # Edit .env with your key
   ```

2. Build and start:
   ```bash
   docker compose up -d --build
   ```

3. Verify all services are healthy:
   ```bash
   docker compose ps
   ```

4. Test the API:
   ```bash
   curl http://localhost:8888/health
   ```

## OpenClaw Integration

Once running, configure OpenClaw to use the self-hosted Mem0:

```json
{
  "mem0": {
    "host": "http://localhost:8888"
  }
}
```

The `@mem0/openclaw-mem0` plugin supports a `host` option that routes all API calls to the self-hosted server.

## Data Persistence

- **PostgreSQL data**: Docker volume `postgres_db`
- **Neo4j data**: Docker volume `neo4j_data`
- **History**: Local `./history/` directory

To wipe everything and start fresh:
```bash
docker compose down -v
```

## Estimated Cost

~$0.31/month (OpenAI API calls for gpt-4.1-nano extraction + text-embedding-3-small embeddings at typical usage).

## Architecture

```
OpenClaw → HTTP → Mem0 API (port 8888)
                    ├── pgvector (embeddings)
                    └── Neo4j (knowledge graph)
```

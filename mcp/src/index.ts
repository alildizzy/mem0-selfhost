#!/usr/bin/env node
/**
 * MCP server for self-hosted Mem0 REST API — Streamable HTTP transport.
 * Runs as an HTTP service; connect clients to http://localhost:3001/mcp
 *
 * Tools: add_memory, search_memory, list_memories, get_memory, delete_memory, update_memory
 */

import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const MEM0_HOST = process.env.MEM0_HOST ?? "http://localhost:8888";
const DEFAULT_USER_ID = process.env.MEM0_USER_ID ?? "default";
const PORT = parseInt(process.env.MCP_PORT ?? "3001", 10);

async function mem0<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${MEM0_HOST}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mem0 ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

function buildServer(): McpServer {
  const server = new McpServer({ name: "mem0-selfhost-mcp", version: "0.1.0" });

  server.tool(
    "add_memory",
    "Store a new memory for a user.",
    {
      text: z.string().describe("The memory content to store."),
      user_id: z.string().optional().describe("User ID to scope the memory."),
    },
    async ({ text, user_id }) => {
      const result = await mem0("POST", "/memories", {
        messages: [{ role: "user", content: text }],
        user_id: user_id ?? DEFAULT_USER_ID,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "search_memory",
    "Search memories by semantic similarity.",
    {
      query: z.string().describe("Search query."),
      user_id: z.string().optional().describe("User ID to search within."),
      limit: z.number().optional().describe("Max results to return (default 5)."),
    },
    async ({ query, user_id, limit }) => {
      const result = await mem0("POST", "/search", {
        query,
        user_id: user_id ?? DEFAULT_USER_ID,
        limit: limit ?? 5,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "list_memories",
    "List all memories for a user.",
    {
      user_id: z.string().optional().describe("User ID."),
      limit: z.number().optional().describe("Max memories to return (default 100)."),
    },
    async ({ user_id, limit }) => {
      const uid = encodeURIComponent(user_id ?? DEFAULT_USER_ID);
      const result = await mem0("GET", `/memories?user_id=${uid}&limit=${limit ?? 100}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "get_memory",
    "Retrieve a specific memory by ID.",
    { memory_id: z.string().describe("Memory UUID.") },
    async ({ memory_id }) => {
      const result = await mem0("GET", `/memories/${memory_id}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "delete_memory",
    "Permanently delete a memory by ID.",
    { memory_id: z.string().describe("Memory UUID to delete.") },
    async ({ memory_id }) => {
      const result = await mem0("DELETE", `/memories/${memory_id}`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    "update_memory",
    "Update the text of an existing memory.",
    {
      memory_id: z.string().describe("Memory UUID to update."),
      text: z.string().describe("New memory content."),
    },
    async ({ memory_id, text }) => {
      const result = await mem0("PUT", `/memories/${memory_id}`, { text });
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    }
  );

  return server;
}

const httpServer = http.createServer(async (req, res) => {
  if (req.url === "/mcp") {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = buildServer();
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  res.writeHead(404).end();
});

httpServer.listen(PORT, () => {
  console.error(`mem0 MCP server listening on http://0.0.0.0:${PORT}/mcp`);
});

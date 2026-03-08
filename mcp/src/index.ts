#!/usr/bin/env node
/**
 * Minimal MCP server for self-hosted Mem0 REST API.
 * Connects to a local Mem0 instance (default: http://localhost:8888).
 *
 * Tools: add_memory, search_memory, list_memories, get_memory, delete_memory, update_memory
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const MEM0_HOST = process.env.MEM0_HOST ?? "http://localhost:8888";
const DEFAULT_USER_ID = process.env.MEM0_USER_ID ?? "default";

async function mem0<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
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

const server = new Server(
  { name: "mem0-selfhost-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "add_memory",
      description: "Store a new memory for a user.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The memory content to store." },
          user_id: { type: "string", description: "User ID to scope the memory.", default: DEFAULT_USER_ID },
        },
        required: ["text"],
      },
    },
    {
      name: "search_memory",
      description: "Search memories by semantic similarity.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          user_id: { type: "string", description: "User ID to search within.", default: DEFAULT_USER_ID },
          limit: { type: "number", description: "Max results to return.", default: 5 },
        },
        required: ["query"],
      },
    },
    {
      name: "list_memories",
      description: "List all memories for a user.",
      inputSchema: {
        type: "object",
        properties: {
          user_id: { type: "string", description: "User ID.", default: DEFAULT_USER_ID },
          limit: { type: "number", description: "Max memories to return.", default: 100 },
        },
      },
    },
    {
      name: "get_memory",
      description: "Retrieve a specific memory by ID.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory UUID." },
        },
        required: ["memory_id"],
      },
    },
    {
      name: "delete_memory",
      description: "Permanently delete a memory by ID.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory UUID to delete." },
        },
        required: ["memory_id"],
      },
    },
    {
      name: "update_memory",
      description: "Update the text of an existing memory.",
      inputSchema: {
        type: "object",
        properties: {
          memory_id: { type: "string", description: "Memory UUID to update." },
          text: { type: "string", description: "New memory content." },
        },
        required: ["memory_id", "text"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const userId = (args.user_id as string | undefined) ?? DEFAULT_USER_ID;

  try {
    let result: unknown;

    switch (name) {
      case "add_memory":
        result = await mem0("POST", "/memories", {
          messages: [{ role: "user", content: args.text }],
          user_id: userId,
        });
        break;

      case "search_memory":
        result = await mem0("POST", "/search", {
          query: args.query,
          user_id: userId,
          limit: args.limit ?? 5,
        });
        break;

      case "list_memories":
        result = await mem0(
          "GET",
          `/memories?user_id=${encodeURIComponent(userId)}&limit=${args.limit ?? 100}`
        );
        break;

      case "get_memory":
        result = await mem0("GET", `/memories/${args.memory_id}`);
        break;

      case "delete_memory":
        result = await mem0("DELETE", `/memories/${args.memory_id}`);
        break;

      case "update_memory":
        result = await mem0("PUT", `/memories/${args.memory_id}`, {
          text: args.text,
        });
        break;

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);

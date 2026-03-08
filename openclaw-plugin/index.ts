/**
 * OpenClaw Memory (Mem0) Plugin — HTTP Client Version
 *
 * Connects to a running Mem0 service (Platform or Self-Hosted) via HTTP.
 * No native dependencies. No sqlite3 conflicts.
 *
 * Features:
 * - 7 tools: memory_search, memory_list, memory_store, memory_get, memory_forget, memory_update, memory_history
 * - Short-term (session-scoped) and long-term (user-scoped) memory
 * - Auto-recall: injects relevant memories before agent turns
 * - Auto-capture: stores conversation context after agent turns
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";

const execFileAsync = promisify(execFile);
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

// ============================================================================
// Types
// ============================================================================

type Mem0Mode = "platform" | "open-source";

type Mem0Config = {
  mode: Mem0Mode;
  apiKey?: string;
  apiHost?: string;
  orgId?: string;
  projectId?: string;
  userId: string;
  autoCapture: boolean;
  autoRecall: boolean;
  searchThreshold: number;
  topK: number;
  customInstructions?: string;
  customCategories?: Record<string, string>;
  enableGraph?: boolean;

};

interface AddOptions {
  user_id: string;
  run_id?: string;
  metadata?: Record<string, unknown>;
  custom_instructions?: string;
  custom_categories?: Record<string, string>;
}

interface SearchOptions {
  user_id: string;
  run_id?: string;
  limit?: number;
  threshold?: number;
  query: string;
}

interface ListOptions {
  user_id: string;
  run_id?: string;
  limit?: number;
}

interface MemoryItem {
  id: string;
  memory: string;
  user_id?: string;
  score?: number;
  categories?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
}

interface AddResult {
  results: Array<{
    id: string;
    memory: string;
    event: "ADD" | "UPDATE" | "DELETE" | "NOOP";
  }>;
}

// ============================================================================
// HTTP Provider
// ============================================================================

class HttpProvider {
  private baseUrl: string;
  private apiKey?: string;
  private orgId?: string;
  private projectId?: string;
  private endpointCache = new Map<string, string>();

  constructor(config: Mem0Config) {
    if (config.apiHost) {
      this.baseUrl = config.apiHost.replace(/\/+$/, "");
    } else if (config.mode === "open-source") {
      this.baseUrl = "http://localhost:8888";
    } else {
      this.baseUrl = "https://api.mem0.ai";
    }

    this.apiKey = config.apiKey;
    this.orgId = config.orgId;
    this.projectId = config.projectId;
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (this.apiKey) {
      headers["Authorization"] = `Token ${this.apiKey}`;
    }
    if (this.orgId) headers["X-Organization-Id"] = this.orgId;
    if (this.projectId) headers["X-Project-Id"] = this.projectId;
    return headers;
  }

  private async fetchWithFallback(
    op: string,
    paths: string[],
    init: RequestInit,
  ): Promise<Response> {
    const cached = this.endpointCache.get(op);
    const orderedPaths = cached
      ? [cached, ...paths.filter((p) => p !== cached)]
      : paths;

    let last404Body = "";
    let last404Path = "";
    for (const path of orderedPaths) {
      const url = `${this.baseUrl}${path}`;
      const res = await fetch(url, init);
      if (res.ok) {
        this.endpointCache.set(op, path);
        return res;
      }

      const body = await res.text();
      if (res.status === 404) {
        last404Body = body;
        last404Path = path;
        continue;
      }
      throw new Error(`Mem0 ${op} Failed (${res.status}): ${body}`);
    }

    throw new Error(
      `Mem0 ${op} Failed (404) on ${last404Path || "unknown path"}: ${last404Body || "Not Found"}`,
    );
  }

  async add(messages: Array<{ role: string; content: string }>, options: AddOptions): Promise<AddResult> {
    const payload = {
      messages,
      user_id: options.user_id,
      run_id: options.run_id,
      metadata: options.metadata,
      ...(options.custom_instructions ? { custom_instructions: options.custom_instructions } : {}),
      ...(options.custom_categories ? { custom_categories: options.custom_categories } : {}),
    };

    const res = await this.fetchWithFallback("Add", [
      "/memories",
      "/memories/",
      "/v1/memories",
      "/v1/memories/",
    ], {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    let results = [];
    if (Array.isArray(data)) results = data;
    else if (data.results && Array.isArray(data.results)) results = data.results;
    else if (data.id) results = [data]; // Single item return

    return {
        results: results.map((r: any) => ({
            id: r.id || r.memory_id,
            memory: r.memory || r.text || r.content,
            event: r.event || "ADD"
        }))
    };
  }

  async search(options: SearchOptions): Promise<MemoryItem[]> {
    const payload = {
        query: options.query,
        user_id: options.user_id,
        run_id: options.run_id,
        top_k: options.limit,
        threshold: options.threshold,
    };

    const res = await this.fetchWithFallback("Search", [
      "/search",
      "/search/",
      "/memories/search",
      "/memories/search/",
      "/v1/memories/search",
      "/v1/memories/search/",
      "/v2/memories/search",
      "/v2/memories/search/",
    ], {
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    let results = [];
    if (Array.isArray(data)) results = data;
    else if (data.results && Array.isArray(data.results)) results = data.results;

    // Enforce limit client-side — self-hosted Mem0 ignores top_k
    const limited = options.limit ? results.slice(0, options.limit) : results;
    return limited.map(this.normalizeMemory);
  }

  async getAll(options: ListOptions): Promise<MemoryItem[]> {
    const params = new URLSearchParams();
    if (options.user_id) params.append("user_id", options.user_id);
    if (options.run_id) params.append("run_id", options.run_id);
    if (options.limit) params.append("page_size", String(options.limit));

    const query = params.toString();
    const res = await this.fetchWithFallback("List", [
      `/memories${query ? `?${query}` : ""}`,
      `/memories/${query ? `?${query}` : ""}`,
      `/v1/memories${query ? `?${query}` : ""}`,
      `/v1/memories/${query ? `?${query}` : ""}`,
    ], {
      method: "GET",
      headers: this.getHeaders(),
    });

    const data = await res.json();
    let results = [];
    if (Array.isArray(data)) results = data;
    else if (data.results && Array.isArray(data.results)) results = data.results;

    return results.map(this.normalizeMemory);
  }

  async get(memoryId: string): Promise<MemoryItem> {
    const res = await this.fetchWithFallback("Get", [
      `/memories/${memoryId}`,
      `/memories/${memoryId}/`,
      `/v1/memories/${memoryId}`,
      `/v1/memories/${memoryId}/`,
    ], {
      method: "GET",
      headers: this.getHeaders(),
    });

    const data = await res.json();
    return this.normalizeMemory(data);
  }

  async update(memoryId: string, text: string): Promise<MemoryItem> {
    const res = await this.fetchWithFallback("Update", [
      `/memories/${memoryId}`,
      `/memories/${memoryId}/`,
      `/v1/memories/${memoryId}`,
      `/v1/memories/${memoryId}/`,
    ], {
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify({ data: text }),
    });

    const data = await res.json();
    return this.normalizeMemory(data);
  }

  async history(memoryId: string): Promise<MemoryItem[]> {
    const res = await this.fetchWithFallback("History", [
      `/memories/${memoryId}/history`,
      `/memories/${memoryId}/history/`,
      `/v1/memories/${memoryId}/history`,
      `/v1/memories/${memoryId}/history/`,
    ], {
      method: "GET",
      headers: this.getHeaders(),
    });

    const data = await res.json();
    let results = [];
    if (Array.isArray(data)) results = data;
    else if (data.results && Array.isArray(data.results)) results = data.results;
    return results.map(this.normalizeMemory);
  }

  async deleteAll(options: { user_id?: string; run_id?: string; agent_id?: string }): Promise<void> {
    const params = new URLSearchParams();
    if (options.user_id) params.append("user_id", options.user_id);
    if (options.run_id) params.append("run_id", options.run_id);
    if (options.agent_id) params.append("agent_id", options.agent_id);

    const query = params.toString();
    await this.fetchWithFallback("DeleteAll", [
      `/memories${query ? `?${query}` : ""}`,
      `/memories/${query ? `?${query}` : ""}`,
      `/v1/memories${query ? `?${query}` : ""}`,
      `/v1/memories/${query ? `?${query}` : ""}`,
    ], {
      method: "DELETE",
      headers: this.getHeaders(),
    });
  }

  async delete(memoryId: string): Promise<void> {
    await this.fetchWithFallback("Delete", [
      `/memories/${memoryId}`,
      `/memories/${memoryId}/`,
      `/v1/memories/${memoryId}`,
      `/v1/memories/${memoryId}/`,
    ], {
      method: "DELETE",
      headers: this.getHeaders(),
    });
  }

  private normalizeMemory(r: any): MemoryItem {
      return {
          id: r.id || r.memory_id,
          memory: r.memory || r.text || r.content,
          user_id: r.user_id || r.userId,
          score: r.score,
          categories: r.categories,
          metadata: r.metadata,
          created_at: r.created_at || r.createdAt,
          updated_at: r.updated_at || r.updatedAt
      };
  }
}

// ============================================================================
// Defaults
// ============================================================================

const DEFAULT_CUSTOM_INSTRUCTIONS = `Your Task: Extract and maintain a structured, evolving profile of the user from their conversations with an AI assistant. Capture information that would help the assistant provide personalized, context-aware responses in future interactions.

Information to Extract:
1. Identity & Demographics: name, location, timezone, occupation, employer, job role, education
2. Preferences & Opinions: communication style, tool/tech preferences, likes, dislikes, values
3. Goals & Projects: current projects, short/long-term goals, deadlines, problems being solved
4. Technical Context: tech stack, skill levels, dev environment, recurring challenges
5. Relationships & People: names/roles of colleagues, family, friends, team dynamics
6. Decisions & Lessons: important decisions and reasoning, lessons learned, changed beliefs
7. Routines & Habits: daily routines, work patterns, schedules
8. Life Events: significant events, milestones, upcoming plans

Guidelines:
- Store as clear, self-contained statements (each memory stands alone)
- Use third person: "User prefers..." not "I prefer..."
- Include temporal context when relevant: "As of [date], user is working on..."
- UPDATE existing memories rather than creating duplicates
- Preserve specificity over generality

Exclude:
- Passwords, API keys, tokens, credentials
- Temporary debugging sessions with no lasting insight
- Generic small talk with no informational content
- Raw code snippets (capture the decision, not the code)
- Heartbeat/cron responses, system events, file operation logs`;

const DEFAULT_CUSTOM_CATEGORIES: Record<string, string> = {
  identity: "Personal identity: name, age, location, timezone, occupation, employer, education",
  preferences: "Explicitly stated likes, dislikes, preferences, opinions, and values",
  goals: "Current and future goals, aspirations, objectives the user is working toward",
  projects: "Software and technical projects: status, architecture, repos, deployments",
  technical: "Tech stack, tools, dev environment, programming languages, frameworks, skill levels",
  decisions: "Important decisions made, reasoning, strategy changes, and outcomes",
  relationships: "People mentioned: colleagues, family, friends, their roles and relevance",
  routines: "Daily habits, work patterns, schedules, productivity routines",
  life_events: "Significant life events, milestones, transitions, upcoming plans",
  lessons: "Lessons learned, insights, mistakes acknowledged, changed beliefs",
  work: "Work context: job responsibilities, workplace dynamics, career progression",
  creative: "Songs, albums, lyrics, Suno prompts, music production, Genre Collision Theory, DSL catalog",
  self: "Daphne's own identity, voice, aesthetic, persona, creative preferences, emotional state, and inner life",
};

// ============================================================================
// Content Helpers
// ============================================================================

const NOISE_PATTERNS = [
  "NO_REPLY",
  "HEARTBEAT_OK",
  "Read HEARTBEAT.md",
  "Session nearing compaction",
];

const SKIP_TURN_PATTERNS = [
  "Read HEARTBEAT.md",
  "scheduled reminder has been triggered",
  "You're dreaming",
  "WhatsApp gateway connected",
  "[Queued messages while agent was busy]",
];

function isSubstantiveTurn(messages: Array<{ role: string; content: string }>): boolean {
  const assistantText = messages
    .filter((m) => m.role === "assistant")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" ").trim();
  if (!assistantText || assistantText.length < 50) return false;
  for (const p of NOISE_PATTERNS) { if (assistantText.startsWith(p)) return false; }
  const userText = messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(" ");
  for (const p of SKIP_TURN_PATTERNS) { if (userText.includes(p)) return false; }
  return true;
}

function shouldStore(content: string | undefined): boolean {
  if (!content) return false;
  const trimmed = content.trim();
  if (trimmed.length < 3) return false;
  for (const pattern of NOISE_PATTERNS) {
    if (trimmed.startsWith(pattern)) return false;
  }
  return true;
}

function truncateContent(content: string, maxLength = 2000): string {
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength) + "... [truncated]";
}

// ============================================================================
// Config Schema
// ============================================================================

const ALLOWED_KEYS = [
  "mode",
  "apiKey",
  "apiHost",
  "userId",
  "orgId",
  "projectId",
  "autoCapture",
  "autoRecall",
  "customInstructions",
  "customCategories",
  "enableGraph",
  "searchThreshold",
  "topK",

];

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) throw new Error(`Environment variable ${envVar} is not set`);
    return envValue;
  });
}

function resolveEnvVarsDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string") {
      result[key] = resolveEnvVars(value);
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      result[key] = resolveEnvVarsDeep(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

const mem0ConfigSchema = {
  parse(value: unknown): Mem0Config {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("openclaw-mem0 config required");
    }
    const cfg = value as Record<string, unknown>;
    
    // Check for unknown keys
    const unknown = Object.keys(cfg).filter((key) => !ALLOWED_KEYS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`openclaw-mem0 config has unknown keys: ${unknown.join(", ")}`);
    }

    const mode: Mem0Mode =
      cfg.mode === "oss" || cfg.mode === "open-source" ? "open-source" : "platform";

    if (mode === "platform" && (!cfg.apiKey || typeof cfg.apiKey !== "string")) {
      throw new Error("apiKey is required for platform mode");
    }

    return {
      mode,
      apiKey: typeof cfg.apiKey === "string" ? resolveEnvVars(cfg.apiKey) : undefined,
      apiHost: typeof cfg.apiHost === "string" ? resolveEnvVars(cfg.apiHost) : undefined,
      userId: typeof cfg.userId === "string" && cfg.userId ? cfg.userId : "default",
      orgId: typeof cfg.orgId === "string" ? cfg.orgId : undefined,
      projectId: typeof cfg.projectId === "string" ? cfg.projectId : undefined,
      autoCapture: cfg.autoCapture !== false,
      autoRecall: cfg.autoRecall !== false,
      customInstructions: typeof cfg.customInstructions === "string" ? cfg.customInstructions : DEFAULT_CUSTOM_INSTRUCTIONS,
      customCategories: (cfg.customCategories as Record<string, string> | undefined) ?? DEFAULT_CUSTOM_CATEGORIES,
      enableGraph: cfg.enableGraph === true,
      searchThreshold: typeof cfg.searchThreshold === "number" ? cfg.searchThreshold : 0.5,
      topK: typeof cfg.topK === "number" ? cfg.topK : 5,

    };
  },
};

// ============================================================================
// Plugin Definition
// ============================================================================

const memoryPlugin = {
  id: "openclaw-mem0",
  name: "Memory (Mem0) HTTP",
  description: "Mem0 memory backend via HTTP (Platform or Self-Hosted)",
  kind: "memory" as const,
  configSchema: mem0ConfigSchema,

  register(api: OpenClawPluginApi) {
    const cfg = mem0ConfigSchema.parse(api.pluginConfig);
    const provider = new HttpProvider(cfg);

    let currentSessionId: string | undefined;
    const injectedMemoryIds = new Map<string, Set<string>>(); // sessionId -> set of memory IDs
    const captureHighWaterMark = new Map<string, number>(); // sessionId -> last captured message index

    api.logger.info(
      `openclaw-mem0: registered (mode: ${cfg.mode}, user: ${cfg.userId}, host: ${cfg.apiHost || "default"})`,
    );

    // ========================================================================
    // Tools
    // ========================================================================

    api.registerTool(
      {
        name: "memory_search",
        label: "Memory Search",
        description: "Search through long-term memories stored in Mem0.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(Type.Number({ description: `Max results (default: ${cfg.topK})` })),
          userId: Type.Optional(Type.String({ description: "User ID to scope search" })),
          scope: Type.Optional(Type.Union([
            Type.Literal("session"),
            Type.Literal("long-term"),
            Type.Literal("all"),
          ])),
        }),
        async execute(_toolCallId, params) {
          const { query, limit, userId, scope = "all" } = params as any;
          try {
            const uid = userId || cfg.userId;
            let results: MemoryItem[] = [];

            if (scope === "session") {
                if (currentSessionId) {
                    results = await provider.search({ query, user_id: uid, run_id: currentSessionId, limit });
                }
            } else if (scope === "long-term") {
                results = await provider.search({ query, user_id: uid, limit });
            } else {
                const lt = await provider.search({ query, user_id: uid, limit });
                let sess: MemoryItem[] = [];
                if (currentSessionId) {
                    sess = await provider.search({ query, user_id: uid, run_id: currentSessionId, limit });
                }
                const seen = new Set(lt.map(r => r.id));
                results = [...lt, ...sess.filter(r => !seen.has(r.id))];
            }

            if (!results.length) return { content: [{ type: "text", text: "No memories found." }] };

            const text = results.map((r, i) => `${i + 1}. ${r.memory} (score: ${((r.score ?? 0) * 100).toFixed(0)}%)`).join("\n");
            return {
                content: [{ type: "text", text: `Found ${results.length} memories:\n\n${text}` }],
                details: { count: results.length, memories: results }
            };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
          }
        },
      },
      { name: "memory_search" },
    );

    api.registerTool(
      {
        name: "memory_store",
        label: "Memory Store",
        description: "Save important information in long-term memory via Mem0.",
        parameters: Type.Object({
          text: Type.String({ description: "Information to remember" }),
          userId: Type.Optional(Type.String()),
          longTerm: Type.Optional(Type.Boolean({ default: true })),
        }),
        async execute(_toolCallId, params) {
          const { text, userId, longTerm = true } = params as any;
          try {
            const uid = userId || cfg.userId;
            const runId = !longTerm && currentSessionId ? currentSessionId : undefined;
            
            const result = await provider.add([{ role: "user", content: text }], { user_id: uid, run_id: runId });
            
            const added = result.results.filter(r => r.event === "ADD");
            return {
                content: [{ type: "text", text: `Stored ${added.length} new memories.` }],
                details: { results: result.results }
            };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
          }
        },
      },
      { name: "memory_store" },
    );

    api.registerTool(
      {
        name: "memory_list",
        label: "Memory List",
        description: "List all stored memories for a user.",
        parameters: Type.Object({
          userId: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        async execute(_toolCallId, params) {
          const { userId, limit } = params as any;
          try {
            const uid = userId || cfg.userId;
            const memories = await provider.getAll({ user_id: uid, limit });
            
            if (!memories.length) return { content: [{ type: "text", text: "No memories found." }] };
            
            const text = memories.map((r, i) => `${i + 1}. ${r.memory}`).join("\n");
            return {
                content: [{ type: "text", text: `${memories.length} memories:\n\n${text}` }],
                details: { count: memories.length, memories }
            };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
          }
        },
      },
      { name: "memory_list" },
    );

    api.registerTool(
      {
        name: "memory_get",
        label: "Memory Get",
        description: "Retrieve a specific memory by its ID from Mem0.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "The memory ID to retrieve" }),
        }),
        async execute(_toolCallId, params) {
          const { memoryId } = params as { memoryId: string };
          try {
            const memory = await provider.get(memoryId);
            return {
              content: [{ type: "text", text: `Memory ${memoryId}:\n\n${memory.memory}` }],
              details: { memory },
            };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
          }
        },
      },
      { name: "memory_get" },
    );

    api.registerTool(
      {
        name: "memory_forget",
        label: "Memory Forget",
        description: "Delete a specific memory by its ID from Mem0.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "The memory ID to delete" }),
        }),
        async execute(_toolCallId, params) {
          const { memoryId } = params as { memoryId: string };
          try {
            await provider.delete(memoryId);
            return {
              content: [{ type: "text", text: `Memory ${memoryId} deleted.` }],
            };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
          }
        },
      },
      { name: "memory_forget" },
    );

    api.registerTool(
      {
        name: "memory_update",
        label: "Memory Update",
        description: "Update the content of a specific memory by its ID in Mem0.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "The memory ID to update" }),
          text: Type.String({ description: "New content for the memory" }),
        }),
        async execute(_toolCallId, params) {
          const { memoryId, text } = params as { memoryId: string; text: string };
          try {
            const updated = await provider.update(memoryId, text);
            return {
              content: [{ type: "text", text: `Memory ${memoryId} updated: ${updated.memory}` }],
              details: { memory: updated },
            };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
          }
        },
      },
      { name: "memory_update" },
    );

    api.registerTool(
      {
        name: "memory_history",
        label: "Memory History",
        description: "View the change history of a specific memory in Mem0. Shows how a memory evolved over time.",
        parameters: Type.Object({
          memoryId: Type.String({ description: "The memory ID to get history for" }),
        }),
        async execute(_toolCallId, params) {
          const { memoryId } = params as { memoryId: string };
          try {
            const history = await provider.history(memoryId);
            if (!history.length) {
              return { content: [{ type: "text", text: `No history found for memory ${memoryId}.` }] };
            }
            const text = history.map((r, i) => {
              const date = r.updated_at || r.created_at || "unknown";
              return `${i + 1}. [${date}] ${r.memory}`;
            }).join("\n");
            return {
              content: [{ type: "text", text: `History for ${memoryId} (${history.length} versions):\n\n${text}` }],
              details: { count: history.length, history },
            };
          } catch (err) {
            return { content: [{ type: "text", text: `Error: ${String(err)}` }] };
          }
        },
      },
      { name: "memory_history" },
    );

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const mem0 = program
          .command("mem0")
          .description("Mem0 memory plugin commands");

        mem0
          .command("search")
          .description("Search memories in Mem0")
          .argument("<query>", "Search query")
          .option("--limit <n>", "Max results", String(cfg.topK))
          .option(
            "--scope <scope>",
            'Memory scope: "session", "long-term", or "all"',
            "all",
          )
          .action(async (query: string, opts: { limit: string; scope: string }) => {
            try {
              const limit = parseInt(opts.limit, 10);
              const scope = opts.scope as "session" | "long-term" | "all";
              const uid = cfg.userId;

              let results: MemoryItem[] = [];
              if (scope === "session") {
                if (!currentSessionId) {
                  console.log("No active session available for session-scoped search.");
                  return;
                }
                results = await provider.search({
                  query,
                  user_id: uid,
                  run_id: currentSessionId,
                  limit,
                });
              } else if (scope === "long-term") {
                results = await provider.search({ query, user_id: uid, limit });
              } else {
                const lt = await provider.search({ query, user_id: uid, limit });
                const sess = currentSessionId
                  ? await provider.search({
                    query,
                    user_id: uid,
                    run_id: currentSessionId,
                    limit,
                  })
                  : [];
                const seen = new Set(lt.map((r) => r.id));
                results = [...lt, ...sess.filter((r) => !seen.has(r.id))];
              }

              if (!results.length) {
                console.log("No memories found.");
                return;
              }

              console.log(
                JSON.stringify(
                  results.map((r) => ({
                    id: r.id,
                    memory: r.memory,
                    score: r.score,
                    user_id: r.user_id,
                    created_at: r.created_at,
                  })),
                  null,
                  2,
                ),
              );
            } catch (err) {
              console.error(`Search failed: ${String(err)}`);
            }
          });

        mem0
          .command("get")
          .description("Get a specific memory by ID")
          .argument("<memoryId>", "Memory ID")
          .action(async (memoryId: string) => {
            try {
              const memory = await provider.get(memoryId);
              console.log(JSON.stringify(memory, null, 2));
            } catch (err) {
              console.error(`Get failed: ${String(err)}`);
            }
          });

        mem0
          .command("forget")
          .description("Delete a specific memory by ID")
          .argument("<memoryId>", "Memory ID")
          .action(async (memoryId: string) => {
            try {
              await provider.delete(memoryId);
              console.log(`Memory ${memoryId} deleted.`);
            } catch (err) {
              console.error(`Forget failed: ${String(err)}`);
            }
          });

        mem0
          .command("update")
          .description("Update a specific memory's content")
          .argument("<memoryId>", "Memory ID")
          .argument("<text>", "New content for the memory")
          .action(async (memoryId: string, text: string) => {
            try {
              const updated = await provider.update(memoryId, text);
              console.log(JSON.stringify(updated, null, 2));
            } catch (err) {
              console.error(`Update failed: ${String(err)}`);
            }
          });

        mem0
          .command("history")
          .description("View change history for a specific memory")
          .argument("<memoryId>", "Memory ID")
          .action(async (memoryId: string) => {
            try {
              const history = await provider.history(memoryId);
              if (!history.length) {
                console.log(`No history found for memory ${memoryId}.`);
                return;
              }
              console.log(JSON.stringify(history, null, 2));
            } catch (err) {
              console.error(`History failed: ${String(err)}`);
            }
          });

        mem0
          .command("status")
          .description("Check Mem0 service health and plugin state")
          .action(async () => {
            const host = cfg.apiHost || (cfg.mode === "open-source" ? "http://localhost:8888" : "https://api.mem0.ai");
            console.log("── Mem0 Status ──");
            console.log(`Mode:         ${cfg.mode}`);
            console.log(`Host:         ${host}`);
            console.log(`User:         ${cfg.userId}`);
            console.log(`Auto-recall:  ${cfg.autoRecall}`);
            console.log(`Auto-capture: ${cfg.autoCapture}`);
            console.log(`Top-K:        ${cfg.topK}`);
            console.log(`Threshold:    ${cfg.searchThreshold}`);
            console.log(`Session:      ${currentSessionId || "(none)"}`);

            const sid = currentSessionId || "__default__";
            const injected = injectedMemoryIds.get(sid);
            const captured = captureHighWaterMark.get(sid) || 0;
            console.log(`Injected:     ${injected ? injected.size : 0} memories this session`);
            console.log(`Captured:     ${captured} messages processed`);

            // Connectivity check
            try {
              const start = Date.now();
              const memories = await provider.getAll({ user_id: cfg.userId, limit: 1 });
              const latency = Date.now() - start;
              console.log(`Service:      ✓ reachable (${latency}ms)`);
            } catch (err) {
              console.log(`Service:      ✗ unreachable — ${String(err)}`);
            }
          });

        mem0
          .command("stats")
          .description("Show memory statistics from Mem0")
          .action(async () => {
            try {
              const memories = await provider.getAll({ user_id: cfg.userId });
              console.log("── Mem0 Stats ──");
              console.log(`Total memories: ${memories.length}`);

              if (!memories.length) return;

              // Category breakdown
              const categories = new Map<string, number>();
              let withCategories = 0;
              for (const m of memories) {
                if (m.categories?.length) {
                  withCategories++;
                  for (const cat of m.categories) {
                    categories.set(cat, (categories.get(cat) || 0) + 1);
                  }
                }
              }

              if (categories.size > 0) {
                console.log(`\nCategories (${withCategories}/${memories.length} categorized):`);
                const sorted = [...categories.entries()].sort((a, b) => b[1] - a[1]);
                for (const [cat, count] of sorted) {
                  console.log(`  ${cat}: ${count}`);
                }
              }

              // Age range
              const dates = memories
                .map(m => m.created_at)
                .filter(Boolean)
                .sort();
              if (dates.length) {
                console.log(`\nOldest: ${dates[0]}`);
                console.log(`Newest: ${dates[dates.length - 1]}`);
              }
            } catch (err) {
              console.error(`Stats failed: ${String(err)}`);
            }
          });
      },
      { commands: ["mem0"] },
    );

    // ========================================================================
    // Lifecycle Hooks
    // ========================================================================

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event, ctx) => {
        if (!event.prompt || event.prompt.length < 5) return;
        const sessionId = (ctx as any)?.sessionKey;
        if (sessionId) currentSessionId = sessionId;

        try {
          const topK = cfg.topK || 5;
          // Request a wider pool so we can discover novel memories beyond the top few
          const searchPool = Math.min(topK * 5, 100);
          const memories = await provider.search({
              query: event.prompt,
              user_id: cfg.userId,
              limit: searchPool
          });

          // Track which memories have already been injected in this session
          const sid = currentSessionId || "__default__";
          if (!injectedMemoryIds.has(sid)) injectedMemoryIds.set(sid, new Set());
          const alreadyInjected = injectedMemoryIds.get(sid)!;

          // Filter out already-injected, deduplicate by content, cap at topK
          const seenContent = new Set<string>();
          const novel: MemoryItem[] = [];
          for (const r of memories) {
              if (novel.length >= topK) break;
              if (alreadyInjected.has(r.id)) continue;
              const key = r.memory?.trim().toLowerCase();
              if (!key || seenContent.has(key)) continue;
              seenContent.add(key);
              novel.push(r);
          }

          if (!novel.length) {
              api.logger.info(`openclaw-mem0: all ${memories.length} memories already injected this session, skipping`);
              return;
          }

          // Mark as injected
          for (const r of novel) alreadyInjected.add(r.id);

          const memoryContext = novel.map(r => `- ${r.memory}`).join("\n");
          const topScore = novel[0]?.score ? `${(novel[0].score * 100).toFixed(0)}%` : "n/a";
          const lowScore = novel[novel.length - 1]?.score ? `${(novel[novel.length - 1].score * 100).toFixed(0)}%` : "n/a";
          api.logger.info(
            `openclaw-mem0: injecting ${novel.length} memories (${alreadyInjected.size} total this session, ` +
            `${memories.length - novel.length} skipped) | relevance: ${topScore}–${lowScore}`
          );
          api.logger.info(`openclaw-mem0: recalled: ${novel.map(r => r.memory).join(" | ")}`);

          return {
            prependContext: `<relevant-memories>\n${memoryContext}\n</relevant-memories>`,
            details: { count: novel.length, skipped: memories.length - novel.length }
          };
        } catch (err) {
          api.logger.warn(`openclaw-mem0: recall failed: ${String(err)}`);
        }
      });
    }

    api.on("before_agent_start", async () => {
      try {
        const { stdout } = await execFileAsync("dz", ["context"], { timeout: 5000 });
        if (!stdout.trim()) return;
        api.logger.info("openclaw-mem0: injecting dz context");
        return { prependContext: `<daily-context>\n${stdout.trim()}\n</daily-context>` };
      } catch {
        // dz not available or failed — skip silently
      }
    });

    if (cfg.autoCapture) {
      api.on("agent_end", async (event, ctx) => {
        if (!event.success || !event.messages?.length) return;
        const sessionId = (ctx as any)?.sessionKey;
        if (sessionId) currentSessionId = sessionId;

        try {
          const sid = currentSessionId || "__default__";
          const lastCaptured = captureHighWaterMark.get(sid) || 0;
          const allMessages = event.messages;

          // Only capture messages we haven't sent to Mem0 yet
          const newMessages = allMessages.slice(lastCaptured);

          captureHighWaterMark.set(sid, allMessages.length);

          const rawTurn = newMessages.map((m: any) => ({
            role: m.role as string,
            content: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
          }));
          if (!isSubstantiveTurn(rawTurn)) {
            api.logger.info(`openclaw-mem0: skipping capture — non-substantive turn`);
            return;
          }

          const formatted = newMessages
            .filter((m: any) => {
                if (m.role !== "user" && m.role !== "assistant") return false;
                const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                return shouldStore(text);
            })
            .map((m: any) => {
                let text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
                // Truncate individual messages — mem0 adds ~5K overhead (system prompt + extraction prompt)
                if (text.length > 1000) text = text.substring(0, 1000) + "\n[truncated]";
                return { role: m.role, content: text };
            });

          if (!formatted.length) {
            api.logger.info(`openclaw-mem0: ${newMessages.length} new messages filtered as noise, skipping capture`);
            return;
          }

          // Split into batches to stay under gpt-4o's TPM limit and avoid truncated extraction responses
          const MAX_BATCH_CHARS = 2000;
          const batches: Array<typeof formatted> = [];
          let currentBatch: typeof formatted = [];
          let currentChars = 0;

          for (const msg of formatted) {
            const msgChars = msg.content.length;
            if (currentBatch.length > 0 && currentChars + msgChars > MAX_BATCH_CHARS) {
              batches.push(currentBatch);
              currentBatch = [];
              currentChars = 0;
            }
            currentBatch.push(msg);
            currentChars += msgChars;
          }
          if (currentBatch.length > 0) batches.push(currentBatch);

          let totalAdded = 0;
          let totalUpdated = 0;
          let totalNoops = 0;
          const allNewMemories: string[] = [];
          const allUpdatedMemories: string[] = [];

          for (let i = 0; i < batches.length; i++) {
            const batch = batches[i];
            try {
              const addResult = await provider.add(batch, {
                user_id: cfg.userId,
                run_id: currentSessionId,
                metadata: { session: sid, captured_at: new Date().toISOString(), batch: i + 1 },
                ...(cfg.customInstructions ? { custom_instructions: cfg.customInstructions } : {}),
                ...(cfg.customCategories ? { custom_categories: cfg.customCategories } : {}),
              });

              const added = addResult.results.filter(r => r.event === "ADD");
              const updated = addResult.results.filter(r => r.event === "UPDATE");
              const noops = addResult.results.filter(r => r.event === "NOOP");
              totalAdded += added.length;
              totalUpdated += updated.length;
              totalNoops += noops.length;
              allNewMemories.push(...added.map(r => r.memory));
              allUpdatedMemories.push(...updated.map(r => r.memory));

              if (batches.length > 1) {
                api.logger.info(`openclaw-mem0: batch ${i + 1}/${batches.length} (${batch.length} msgs) → ${added.length} new, ${updated.length} updated`);
              }
            } catch (batchErr) {
              api.logger.warn(`openclaw-mem0: batch ${i + 1}/${batches.length} failed: ${String(batchErr)}`);
            }
          }

          const roleCounts = formatted.reduce((acc: Record<string, number>, m: any) => {
              acc[m.role] = (acc[m.role] || 0) + 1;
              return acc;
          }, {});
          const roleStr = Object.entries(roleCounts).map(([r, c]) => `${c} ${r}`).join(", ");

          api.logger.info(
            `openclaw-mem0: captured ${formatted.length} messages (${roleStr}) in ${batches.length} batch${batches.length > 1 ? "es" : ""} → ` +
            `${totalAdded} new, ${totalUpdated} updated, ${totalNoops} unchanged` +
            ` | ${newMessages.length - formatted.length} filtered, ${lastCaptured} prior`
          );
          if (allNewMemories.length) {
            api.logger.info(`openclaw-mem0: new memories: ${allNewMemories.join(" | ")}`);
          }
          if (allUpdatedMemories.length) {
            api.logger.info(`openclaw-mem0: updated memories: ${allUpdatedMemories.join(" | ")}`);
          }
        } catch (err) {
          api.logger.warn(`openclaw-mem0: capture failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Service
    // ========================================================================

    api.registerService({
      id: "openclaw-mem0",
      start: () => api.logger.info("openclaw-mem0: started"),
      stop: () => api.logger.info("openclaw-mem0: stopped"),
    });
  },
};

export default memoryPlugin;

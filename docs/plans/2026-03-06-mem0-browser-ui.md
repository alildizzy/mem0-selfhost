# Mem0 Browser UI Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local Vite + React + TypeScript SPA to browse, search, and manage memories in the self-hosted mem0 instance, with a graph visualization of Neo4j entities.

**Architecture:** Single-page app with three views — Memory List (paginated table with search), Memory Detail (single memory with edit/delete + history), and Graph Explorer (Neo4j entity/relationship visualization). API client is a singleton service using Zod for runtime validation of all API responses. No backend — talks directly to mem0 at `localhost:8888` and Neo4j HTTP API at `localhost:8474`.

**Tech Stack:** Vite, React 19, TypeScript strict, Zod, TanStack Query (caching/pagination), TanStack Router (type-safe routes), Tailwind CSS, `@react-sigma/core` + graphology (graph viz)

---

## Project Setup

**Directory:** `~/mem0-selfhost/ui/`

**Ports:**
- UI dev server: `http://localhost:5173`
- Mem0 API: `http://localhost:8888`
- Neo4j HTTP: `http://localhost:8474`

---

### Task 1: Scaffold Vite + React + TS Project

**Files:**
- Create: `ui/package.json`
- Create: `ui/tsconfig.json`
- Create: `ui/vite.config.ts`
- Create: `ui/index.html`
- Create: `ui/src/main.tsx`
- Create: `ui/src/App.tsx`
- Create: `ui/tailwind.config.ts`
- Create: `ui/postcss.config.js`
- Create: `ui/src/index.css`

**Step 1: Scaffold with Vite**

```bash
cd ~/mem0-selfhost
npm create vite@latest ui -- --template react-ts
cd ui
```

**Step 2: Install dependencies**

```bash
npm install @tanstack/react-query @tanstack/react-router zod tailwindcss @tailwindcss/vite
npm install -D @types/node
```

**Step 3: Configure Tailwind**

`vite.config.ts`:
```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8888",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      "/neo4j": {
        target: "http://localhost:8474",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/neo4j/, ""),
      },
    },
  },
});
```

`src/index.css`:
```css
@import "tailwindcss";
```

**Step 4: Verify dev server starts**

```bash
npm run dev
```

Expected: Vite dev server at `http://localhost:5173` with default React page.

**Step 5: Commit**

```bash
git init
echo "node_modules\ndist" > .gitignore
git add -A
git commit -m "feat: scaffold vite + react + ts project with tailwind"
```

---

### Task 2: Zod Schemas + API Types

**Files:**
- Create: `ui/src/schemas/memory.ts`
- Create: `ui/src/schemas/graph.ts`

**Step 1: Write memory schemas**

`ui/src/schemas/memory.ts`:
```ts
import { z } from "zod";

export const MemorySchema = z.object({
  id: z.string(),
  memory: z.string(),
  hash: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string(),
  updated_at: z.string().nullable(),
  user_id: z.string().nullable(),
});

export const MemoryListSchema = z.array(MemorySchema);

export const SearchResultSchema = z.object({
  id: z.string(),
  memory: z.string(),
  score: z.number().optional(),
  metadata: z.record(z.unknown()).nullable(),
  created_at: z.string().optional(),
  updated_at: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
});

export const SearchResultsSchema = z.array(SearchResultSchema);

export const MemoryHistoryEntrySchema = z.object({
  id: z.string(),
  memory_id: z.string().optional(),
  old_memory: z.string().nullable().optional(),
  new_memory: z.string().nullable().optional(),
  event: z.string(),
  created_at: z.string().optional(),
  updated_at: z.string().nullable().optional(),
});

export const MemoryHistorySchema = z.array(MemoryHistoryEntrySchema);

export type Memory = z.infer<typeof MemorySchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type MemoryHistoryEntry = z.infer<typeof MemoryHistoryEntrySchema>;
```

**Step 2: Write graph schemas**

`ui/src/schemas/graph.ts`:
```ts
import { z } from "zod";

export const GraphNodeSchema = z.object({
  name: z.string(),
});

export const GraphEdgeSchema = z.object({
  source: z.string(),
  relationship: z.string(),
  target: z.string(),
});

export const GraphEdgesSchema = z.array(GraphEdgeSchema);

export type GraphNode = z.infer<typeof GraphNodeSchema>;
export type GraphEdge = z.infer<typeof GraphEdgeSchema>;
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add zod schemas for memory and graph types"
```

---

### Task 3: Singleton API Client

**Files:**
- Create: `ui/src/services/mem0-client.ts`
- Create: `ui/src/services/neo4j-client.ts`

**Step 1: Write mem0 client singleton**

`ui/src/services/mem0-client.ts`:
```ts
import {
  MemorySchema,
  MemoryListSchema,
  SearchResultsSchema,
  MemoryHistorySchema,
  type Memory,
  type SearchResult,
  type MemoryHistoryEntry,
} from "../schemas/memory";

const BASE = "/api";
const USER_ID = "daphne-nightingale";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status}: ${body}`);
  }
  return res.json();
}

function listMemories(): Promise<Memory[]> {
  return request(`${BASE}/memories?user_id=${USER_ID}`).then((data) => {
    const raw = Array.isArray(data) ? data : (data as any).results ?? [];
    return MemoryListSchema.parse(raw);
  });
}

function getMemory(id: string): Promise<Memory> {
  return request(`${BASE}/memories/${id}`).then((data) =>
    MemorySchema.parse(data)
  );
}

function getMemoryHistory(id: string): Promise<MemoryHistoryEntry[]> {
  return request(`${BASE}/memories/${id}/history`).then((data) => {
    const raw = Array.isArray(data) ? data : (data as any).results ?? [];
    return MemoryHistorySchema.parse(raw);
  });
}

function searchMemories(
  query: string,
  topK = 20
): Promise<SearchResult[]> {
  return request(`${BASE}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, user_id: USER_ID, top_k: topK }),
  }).then((data) => {
    const raw = Array.isArray(data) ? data : (data as any).results ?? [];
    return SearchResultsSchema.parse(raw);
  });
}

function deleteMemory(id: string): Promise<void> {
  return request(`${BASE}/memories/${id}`, { method: "DELETE" }).then(
    () => undefined
  );
}

function updateMemory(id: string, text: string): Promise<Memory> {
  return request(`${BASE}/memories/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  }).then((data) => MemorySchema.parse(data));
}

export const mem0 = {
  listMemories,
  getMemory,
  getMemoryHistory,
  searchMemories,
  deleteMemory,
  updateMemory,
} as const;
```

**Step 2: Write Neo4j client singleton**

`ui/src/services/neo4j-client.ts`:
```ts
import { GraphEdgesSchema, type GraphEdge } from "../schemas/graph";

const BASE = "/neo4j";
const AUTH = btoa("neo4j:mem0graph");

async function cypher(query: string, params: Record<string, unknown> = {}): Promise<any[][]> {
  const res = await fetch(`${BASE}/db/neo4j/tx/commit`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${AUTH}`,
    },
    body: JSON.stringify({
      statements: [{ statement: query, parameters: params }],
    }),
  });
  if (!res.ok) throw new Error(`Neo4j ${res.status}`);
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data.results[0]?.data?.map((d: any) => d.row) ?? [];
}

function getGraph(limit = 200): Promise<GraphEdge[]> {
  return cypher(
    `MATCH (n)-[r]->(m) RETURN n.name, type(r), m.name LIMIT $limit`,
    { limit }
  ).then((rows) =>
    GraphEdgesSchema.parse(
      rows.map(([source, relationship, target]) => ({
        source,
        relationship,
        target,
      }))
    )
  );
}

function searchGraph(name: string, limit = 50): Promise<GraphEdge[]> {
  return cypher(
    `MATCH (n)-[r]->(m) WHERE toLower(n.name) CONTAINS toLower($name) OR toLower(m.name) CONTAINS toLower($name) RETURN n.name, type(r), m.name LIMIT $limit`,
    { name, limit }
  ).then((rows) =>
    GraphEdgesSchema.parse(
      rows.map(([source, relationship, target]) => ({
        source,
        relationship,
        target,
      }))
    )
  );
}

function getNodeCount(): Promise<number> {
  return cypher("MATCH (n) RETURN count(n)").then(
    (rows) => rows[0]?.[0] ?? 0
  );
}

function getEdgeCount(): Promise<number> {
  return cypher("MATCH ()-[r]->() RETURN count(r)").then(
    (rows) => rows[0]?.[0] ?? 0
  );
}

export const neo4j = {
  getGraph,
  searchGraph,
  getNodeCount,
  getEdgeCount,
} as const;
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add singleton API clients for mem0 and neo4j"
```

---

### Task 4: TanStack Query Hooks

**Files:**
- Create: `ui/src/hooks/use-memories.ts`
- Create: `ui/src/hooks/use-graph.ts`

**Step 1: Write memory hooks**

`ui/src/hooks/use-memories.ts`:
```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { mem0 } from "../services/mem0-client";

export function useMemories() {
  return useQuery({
    queryKey: ["memories"],
    queryFn: mem0.listMemories,
  });
}

export function useMemory(id: string) {
  return useQuery({
    queryKey: ["memory", id],
    queryFn: () => mem0.getMemory(id),
    enabled: !!id,
  });
}

export function useMemoryHistory(id: string) {
  return useQuery({
    queryKey: ["memory-history", id],
    queryFn: () => mem0.getMemoryHistory(id),
    enabled: !!id,
  });
}

export function useSearchMemories(query: string) {
  return useQuery({
    queryKey: ["memory-search", query],
    queryFn: () => mem0.searchMemories(query),
    enabled: query.length >= 2,
  });
}

export function useDeleteMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: mem0.deleteMemory,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["memories"] }),
  });
}

export function useUpdateMemory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) =>
      mem0.updateMemory(id, text),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["memories"] });
      qc.invalidateQueries({ queryKey: ["memory", vars.id] });
    },
  });
}
```

**Step 2: Write graph hooks**

`ui/src/hooks/use-graph.ts`:
```ts
import { useQuery } from "@tanstack/react-query";
import { neo4j } from "../services/neo4j-client";

export function useGraph(limit = 200) {
  return useQuery({
    queryKey: ["graph", limit],
    queryFn: () => neo4j.getGraph(limit),
  });
}

export function useGraphSearch(name: string, limit = 50) {
  return useQuery({
    queryKey: ["graph-search", name, limit],
    queryFn: () => neo4j.searchGraph(name, limit),
    enabled: name.length >= 2,
  });
}

export function useGraphStats() {
  return useQuery({
    queryKey: ["graph-stats"],
    queryFn: async () => ({
      nodes: await neo4j.getNodeCount(),
      edges: await neo4j.getEdgeCount(),
    }),
  });
}
```

**Step 3: Commit**

```bash
git add -A
git commit -m "feat: add TanStack Query hooks for memories and graph"
```

---

### Task 5: Layout Shell + Routing

**Files:**
- Create: `ui/src/components/Layout.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/main.tsx`

**Step 1: Write layout component**

`ui/src/components/Layout.tsx`:
```tsx
import { Link, Outlet, useMatchRoute } from "@tanstack/react-router";

const NAV = [
  { to: "/", label: "Memories" },
  { to: "/search", label: "Search" },
  { to: "/graph", label: "Graph" },
] as const;

export function Layout() {
  const matchRoute = useMatchRoute();

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <nav className="border-b border-zinc-800 px-6 py-3 flex items-center gap-6">
        <span className="text-lg font-semibold tracking-tight text-white">
          mem0
        </span>
        <div className="flex gap-1">
          {NAV.map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className={`px-3 py-1.5 rounded text-sm transition-colors ${
                matchRoute({ to })
                  ? "bg-zinc-800 text-white"
                  : "text-zinc-400 hover:text-white hover:bg-zinc-800/50"
              }`}
            >
              {label}
            </Link>
          ))}
        </div>
      </nav>
      <main className="max-w-7xl mx-auto px-6 py-6">
        <Outlet />
      </main>
    </div>
  );
}
```

**Step 2: Set up router and query provider in App.tsx and main.tsx**

This step involves setting up TanStack Router with routes for `/`, `/search`, `/graph`, and `/memory/:id`. Wire `QueryClientProvider` in `main.tsx`.

`ui/src/App.tsx`:
```tsx
import {
  createRouter,
  createRoute,
  createRootRoute,
  RouterProvider,
} from "@tanstack/react-router";
import { Layout } from "./components/Layout";

const rootRoute = createRootRoute({ component: Layout });

// Lazy-load pages — stubs for now, built in later tasks
function MemoriesPage() {
  return <div className="text-zinc-400">Memories list — Task 6</div>;
}
function SearchPage() {
  return <div className="text-zinc-400">Search — Task 7</div>;
}
function GraphPage() {
  return <div className="text-zinc-400">Graph explorer — Task 8</div>;
}
function MemoryDetailPage() {
  return <div className="text-zinc-400">Memory detail — Task 7</div>;
}

const memoriesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: MemoriesPage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
  component: SearchPage,
});

const graphRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/graph",
  component: GraphPage,
});

const memoryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/memory/$memoryId",
  component: MemoryDetailPage,
});

const routeTree = rootRoute.addChildren([
  memoriesRoute,
  searchRoute,
  graphRoute,
  memoryDetailRoute,
]);

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

export function App() {
  return <RouterProvider router={router} />;
}
```

`ui/src/main.tsx`:
```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, retry: 1 },
  },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
```

**Step 3: Verify routing works**

```bash
npm run dev
```

Navigate to `/`, `/search`, `/graph` — each shows placeholder text. Nav highlights active route.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add layout shell with TanStack Router navigation"
```

---

### Task 6: Memories List Page

**Files:**
- Create: `ui/src/pages/MemoriesPage.tsx`
- Modify: `ui/src/App.tsx` (swap stub)

**Step 1: Build the memories list page**

`ui/src/pages/MemoriesPage.tsx`:
```tsx
import { useState, useMemo } from "react";
import { Link } from "@tanstack/react-router";
import { useMemories, useDeleteMemory } from "../hooks/use-memories";
import type { Memory } from "../schemas/memory";

const PAGE_SIZE = 25;

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MemoriesPage() {
  const { data: memories, isLoading, error } = useMemories();
  const deleteMutation = useDeleteMemory();
  const [page, setPage] = useState(0);
  const [filter, setFilter] = useState("");

  const filtered = useMemo(() => {
    if (!memories) return [];
    const q = filter.toLowerCase();
    const list = q
      ? memories.filter((m) => m.memory.toLowerCase().includes(q))
      : memories;
    return list.sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    );
  }, [memories, filter]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageItems = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  if (isLoading) return <p className="text-zinc-500">Loading...</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold">
          Memories{" "}
          <span className="text-zinc-500 text-base font-normal">
            ({filtered.length})
          </span>
        </h1>
        <input
          type="text"
          placeholder="Filter..."
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(0);
          }}
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 w-64 focus:outline-none focus:border-zinc-500"
        />
      </div>

      <div className="border border-zinc-800 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-zinc-900 text-zinc-400 text-left">
            <tr>
              <th className="px-4 py-2 font-medium">Memory</th>
              <th className="px-4 py-2 font-medium w-44">Created</th>
              <th className="px-4 py-2 font-medium w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800">
            {pageItems.map((m) => (
              <tr key={m.id} className="hover:bg-zinc-900/50">
                <td className="px-4 py-2">
                  <Link
                    to="/memory/$memoryId"
                    params={{ memoryId: m.id }}
                    className="text-zinc-100 hover:text-white hover:underline"
                  >
                    {m.memory.length > 120
                      ? m.memory.slice(0, 120) + "..."
                      : m.memory}
                  </Link>
                </td>
                <td className="px-4 py-2 text-zinc-500">
                  {formatDate(m.created_at)}
                </td>
                <td className="px-4 py-2">
                  <button
                    onClick={() => {
                      if (confirm("Delete this memory?"))
                        deleteMutation.mutate(m.id);
                    }}
                    className="text-red-400/60 hover:text-red-400 text-xs"
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-4 text-sm text-zinc-400">
          <button
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
            className="px-2 py-1 rounded hover:bg-zinc-800 disabled:opacity-30"
          >
            Prev
          </button>
          <span>
            {page + 1} / {totalPages}
          </span>
          <button
            disabled={page >= totalPages - 1}
            onClick={() => setPage(page + 1)}
            className="px-2 py-1 rounded hover:bg-zinc-800 disabled:opacity-30"
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
```

**Step 2: Update App.tsx to use real component**

Replace `MemoriesPage` stub import with:
```ts
import { MemoriesPage } from "./pages/MemoriesPage";
```

**Step 3: Verify**

```bash
npm run dev
```

Navigate to `/` — should show paginated memory table with filter, delete buttons, and links to detail view.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat: add memories list page with filter, pagination, delete"
```

---

### Task 7: Search Page + Memory Detail Page

**Files:**
- Create: `ui/src/pages/SearchPage.tsx`
- Create: `ui/src/pages/MemoryDetailPage.tsx`
- Modify: `ui/src/App.tsx` (swap stubs)

**Step 1: Build search page**

`ui/src/pages/SearchPage.tsx`:
```tsx
import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useSearchMemories } from "../hooks/use-memories";

export function SearchPage() {
  const [query, setQuery] = useState("");
  const { data: results, isLoading } = useSearchMemories(query);

  return (
    <div>
      <h1 className="text-xl font-semibold mb-4">Semantic Search</h1>
      <input
        type="text"
        placeholder="Search memories by meaning..."
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="bg-zinc-900 border border-zinc-700 rounded px-4 py-2 text-zinc-100 placeholder-zinc-500 w-full mb-4 focus:outline-none focus:border-zinc-500"
      />

      {isLoading && <p className="text-zinc-500">Searching...</p>}

      {results && (
        <div className="space-y-2">
          {results.map((r) => (
            <Link
              key={r.id}
              to="/memory/$memoryId"
              params={{ memoryId: r.id }}
              className="block border border-zinc-800 rounded-lg p-3 hover:bg-zinc-900/50 transition-colors"
            >
              <div className="flex items-start justify-between gap-4">
                <p className="text-zinc-100 text-sm">{r.memory}</p>
                {r.score !== undefined && (
                  <span className="text-xs text-zinc-500 whitespace-nowrap">
                    {(r.score * 100).toFixed(0)}%
                  </span>
                )}
              </div>
            </Link>
          ))}
          {results.length === 0 && query.length >= 2 && (
            <p className="text-zinc-500 text-sm">No results found.</p>
          )}
        </div>
      )}
    </div>
  );
}
```

**Step 2: Build memory detail page**

`ui/src/pages/MemoryDetailPage.tsx`:
```tsx
import { useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  useMemory,
  useMemoryHistory,
  useDeleteMemory,
  useUpdateMemory,
} from "../hooks/use-memories";

export function MemoryDetailPage() {
  const { memoryId } = useParams({ from: "/memory/$memoryId" });
  const { data: memory, isLoading, error } = useMemory(memoryId);
  const { data: history } = useMemoryHistory(memoryId);
  const deleteMutation = useDeleteMemory();
  const updateMutation = useUpdateMemory();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");

  if (isLoading) return <p className="text-zinc-500">Loading...</p>;
  if (error) return <p className="text-red-400">Error: {String(error)}</p>;
  if (!memory) return <p className="text-zinc-500">Not found.</p>;

  return (
    <div className="max-w-3xl">
      <button
        onClick={() => navigate({ to: "/" })}
        className="text-zinc-500 text-sm hover:text-zinc-300 mb-4 block"
      >
        &larr; Back to memories
      </button>

      <div className="border border-zinc-800 rounded-lg p-4 mb-4">
        {editing ? (
          <div>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-700 rounded p-2 text-zinc-100 text-sm min-h-24 focus:outline-none focus:border-zinc-500"
            />
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => {
                  updateMutation.mutate(
                    { id: memoryId, text: editText },
                    { onSuccess: () => setEditing(false) }
                  );
                }}
                className="px-3 py-1 bg-zinc-700 rounded text-sm hover:bg-zinc-600"
              >
                Save
              </button>
              <button
                onClick={() => setEditing(false)}
                className="px-3 py-1 text-zinc-500 text-sm hover:text-zinc-300"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <p className="text-zinc-100 whitespace-pre-wrap">{memory.memory}</p>
        )}
      </div>

      <div className="flex gap-3 text-sm mb-6">
        <span className="text-zinc-500">ID: {memory.id}</span>
        <span className="text-zinc-500">
          Created: {new Date(memory.created_at).toLocaleString()}
        </span>
        {memory.updated_at && (
          <span className="text-zinc-500">
            Updated: {new Date(memory.updated_at).toLocaleString()}
          </span>
        )}
      </div>

      <div className="flex gap-2 mb-8">
        <button
          onClick={() => {
            setEditText(memory.memory);
            setEditing(true);
          }}
          className="px-3 py-1.5 bg-zinc-800 rounded text-sm hover:bg-zinc-700"
        >
          Edit
        </button>
        <button
          onClick={() => {
            if (confirm("Permanently delete this memory?")) {
              deleteMutation.mutate(memoryId, {
                onSuccess: () => navigate({ to: "/" }),
              });
            }
          }}
          className="px-3 py-1.5 text-red-400 border border-red-400/30 rounded text-sm hover:bg-red-400/10"
        >
          Delete
        </button>
      </div>

      {history && history.length > 0 && (
        <div>
          <h2 className="text-lg font-semibold mb-3">History</h2>
          <div className="space-y-2">
            {history.map((h, i) => (
              <div
                key={i}
                className="border border-zinc-800 rounded p-3 text-sm"
              >
                <span className="text-zinc-500 text-xs uppercase">
                  {h.event}
                </span>
                {h.old_memory && (
                  <p className="text-red-400/70 line-through mt-1">
                    {h.old_memory}
                  </p>
                )}
                {h.new_memory && (
                  <p className="text-green-400/70 mt-1">{h.new_memory}</p>
                )}
                {h.created_at && (
                  <p className="text-zinc-600 text-xs mt-1">
                    {new Date(h.created_at).toLocaleString()}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Update App.tsx to use real components**

Replace `SearchPage` and `MemoryDetailPage` stubs.

**Step 4: Verify**

Navigate to `/search`, type a query — semantic results appear with scores. Click a result — detail page shows memory, edit/delete buttons, and history timeline.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add search page and memory detail page with edit/delete/history"
```

---

### Task 8: Graph Explorer Page

**Files:**
- Create: `ui/src/pages/GraphPage.tsx`
- Modify: `ui/src/App.tsx` (swap stub)

**Step 1: Install graph dependencies**

```bash
npm install graphology graphology-types sigma @react-sigma/core graphology-layout-forceatlas2
```

**Step 2: Build graph explorer page**

`ui/src/pages/GraphPage.tsx`:
```tsx
import { useState, useEffect, useMemo } from "react";
import Graph from "graphology";
import { SigmaContainer } from "@react-sigma/core";
import "@react-sigma/core/lib/style.css";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { useGraph, useGraphSearch, useGraphStats } from "../hooks/use-graph";
import type { GraphEdge } from "../schemas/graph";

function buildGraph(edges: GraphEdge[]): Graph {
  const g = new Graph();
  for (const { source, relationship, target } of edges) {
    if (!g.hasNode(source))
      g.addNode(source, {
        label: source,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 6,
        color: "#a78bfa",
      });
    if (!g.hasNode(target))
      g.addNode(target, {
        label: target,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 6,
        color: "#a78bfa",
      });
    const edgeKey = `${source}-${relationship}-${target}`;
    if (!g.hasEdge(edgeKey))
      g.addEdgeWithKey(edgeKey, source, target, {
        label: relationship,
        size: 1,
        color: "#3f3f46",
      });
  }

  // Scale node size by degree
  g.forEachNode((node) => {
    g.setNodeAttribute(node, "size", 4 + g.degree(node) * 0.8);
  });

  // Run layout
  forceAtlas2.assign(g, { iterations: 100, settings: { gravity: 1 } });

  return g;
}

export function GraphPage() {
  const [search, setSearch] = useState("");
  const { data: stats } = useGraphStats();
  const { data: edges, isLoading } = search.length >= 2
    ? useGraphSearch(search)
    : useGraph(300);

  const graph = useMemo(() => {
    if (!edges?.length) return null;
    return buildGraph(edges);
  }, [edges]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-xl font-semibold">Knowledge Graph</h1>
          {stats && (
            <p className="text-zinc-500 text-sm">
              {stats.nodes.toLocaleString()} nodes &middot;{" "}
              {stats.edges.toLocaleString()} edges
            </p>
          )}
        </div>
        <input
          type="text"
          placeholder="Search entities..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-sm text-zinc-100 placeholder-zinc-500 w-64 focus:outline-none focus:border-zinc-500"
        />
      </div>

      {isLoading && <p className="text-zinc-500">Loading graph...</p>}

      {graph && (
        <div className="border border-zinc-800 rounded-lg overflow-hidden" style={{ height: "70vh" }}>
          <SigmaContainer
            graph={graph}
            settings={{
              renderEdgeLabels: true,
              defaultEdgeType: "arrow",
              labelColor: { color: "#d4d4d8" },
              labelSize: 12,
            }}
            style={{ height: "100%", width: "100%", background: "#09090b" }}
          />
        </div>
      )}

      {!isLoading && edges && (
        <div className="mt-4 border border-zinc-800 rounded-lg overflow-hidden max-h-60 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="bg-zinc-900 text-zinc-500 sticky top-0">
              <tr>
                <th className="px-3 py-1.5 text-left">Source</th>
                <th className="px-3 py-1.5 text-left">Relationship</th>
                <th className="px-3 py-1.5 text-left">Target</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {edges.map((e, i) => (
                <tr key={i} className="hover:bg-zinc-900/50">
                  <td className="px-3 py-1 text-zinc-300">{e.source}</td>
                  <td className="px-3 py-1 text-zinc-500">{e.relationship}</td>
                  <td className="px-3 py-1 text-zinc-300">{e.target}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

**Step 3: Update App.tsx**

Replace `GraphPage` stub.

**Step 4: Verify**

Navigate to `/graph` — force-directed graph renders with purple nodes. Search "jonathan" — filters to Jonathan's entity connections. Edge table shows below.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add graph explorer with sigma.js force-directed layout"
```

---

### Task 9: Docker Integration

**Files:**
- Create: `ui/Dockerfile`
- Modify: `~/mem0-selfhost/docker-compose.yaml`

**Step 1: Create Dockerfile for UI**

`ui/Dockerfile`:
```dockerfile
FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
```

**Step 2: Create nginx config**

`ui/nginx.conf`:
```nginx
server {
    listen 3000;
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://mem0:8000/;
    }

    location /neo4j/ {
        proxy_pass http://neo4j:7474/;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**Step 3: Add to docker-compose.yaml**

Add this service to `~/mem0-selfhost/docker-compose.yaml`:

```yaml
  mem0-ui:
    build: ui/
    ports:
      - "3000:3000"
    depends_on:
      - mem0
      - neo4j
    networks:
      - mem0_network
```

**Step 4: Verify**

```bash
cd ~/mem0-selfhost
docker compose up -d mem0-ui
```

Navigate to `http://localhost:3000` — UI serves from Docker, proxies to mem0 and Neo4j.

**Step 5: Commit**

```bash
git add -A
git commit -m "feat: add docker integration for mem0 browser UI"
```

---

## Summary

| Task | What | Commit |
|------|------|--------|
| 1 | Scaffold Vite + React + TS + Tailwind | `feat: scaffold vite + react + ts project` |
| 2 | Zod schemas for mem0 + Neo4j responses | `feat: add zod schemas` |
| 3 | Singleton API clients (mem0 + Neo4j) | `feat: add singleton API clients` |
| 4 | TanStack Query hooks | `feat: add TanStack Query hooks` |
| 5 | Layout shell + TanStack Router | `feat: add layout shell with navigation` |
| 6 | Memories list page (filter, paginate, delete) | `feat: add memories list page` |
| 7 | Search page + Memory detail (edit, delete, history) | `feat: add search and detail pages` |
| 8 | Graph explorer (sigma.js + ForceAtlas2) | `feat: add graph explorer` |
| 9 | Docker integration (nginx proxy) | `feat: add docker integration` |

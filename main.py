import json as _json_stdlib
import logging
import os
import time
import uuid
from collections import defaultdict, deque
from contextvars import ContextVar
from threading import Lock
from typing import Any, Dict, List, Optional

_request_id: ContextVar[str] = ContextVar("request_id", default="-")

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from starlette.middleware.base import BaseHTTPMiddleware

from mem0 import Memory


# ---------------------------------------------------------------------------
# Structured JSON logging
# ---------------------------------------------------------------------------
class JSONFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            "ts": self.formatTime(record, self.datefmt),
            "level": record.levelname,
            "msg": record.getMessage(),
            "logger": record.name,
        }
        if record.exc_info and record.exc_info[0] is not None:
            entry["exception"] = self.formatException(record.exc_info)
        if hasattr(record, "extra_data"):
            entry.update(record.extra_data)
        return _json_stdlib.dumps(entry, default=str)


handler = logging.StreamHandler()
handler.setFormatter(JSONFormatter())
logging.root.handlers = [handler]
logging.root.setLevel(logging.INFO)
logger = logging.getLogger("mem0")


def log_with_data(level: int, msg: str, **kwargs):
    record = logger.makeRecord(
        logger.name, level, "(mem0)", 0, msg, (), None,
    )
    entry = {"request_id": _request_id.get()}
    entry.update(kwargs)
    record.extra_data = entry
    logger.handle(record)


# ---------------------------------------------------------------------------
# In-memory throughput metrics
# ---------------------------------------------------------------------------
class Metrics:
    _RPM_WINDOW = 60.0

    def __init__(self):
        self._lock = Lock()
        self._counts: Dict[str, int] = defaultdict(int)
        self._durations: Dict[str, float] = defaultdict(float)
        self._errors: Dict[str, int] = defaultdict(int)
        self._timestamps: Dict[str, deque] = defaultdict(deque)
        self._user_counts: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
        self._start_time = time.time()

    def record(self, operation: str, duration_ms: float, error: bool = False,
               user_id: Optional[str] = None):
        now = time.time()
        with self._lock:
            self._counts[operation] += 1
            self._durations[operation] += duration_ms
            if error:
                self._errors[operation] += 1
            ts = self._timestamps[operation]
            ts.append(now)
            cutoff = now - self._RPM_WINDOW
            while ts and ts[0] < cutoff:
                ts.popleft()
            if user_id:
                self._user_counts[user_id][operation] += 1

    def snapshot(self) -> dict:
        now = time.time()
        with self._lock:
            uptime = now - self._start_time
            ops = {}
            for op in self._counts:
                count = self._counts[op]
                ts = self._timestamps[op]
                cutoff = now - self._RPM_WINDOW
                while ts and ts[0] < cutoff:
                    ts.popleft()
                ops[op] = {
                    "count": count,
                    "errors": self._errors.get(op, 0),
                    "total_ms": round(self._durations[op], 1),
                    "avg_ms": round(self._durations[op] / count, 1) if count else 0,
                    "rpm": len(ts),
                }
            return {"uptime_s": round(uptime, 1), "operations": ops}

    def user_snapshot(self) -> dict:
        with self._lock:
            return {uid: dict(ops) for uid, ops in self._user_counts.items()}


metrics = Metrics()

# Load environment variables
load_dotenv()


POSTGRES_HOST = os.environ.get("POSTGRES_HOST", "postgres")
POSTGRES_PORT = os.environ.get("POSTGRES_PORT", "5432")
POSTGRES_DB = os.environ.get("POSTGRES_DB", "postgres")
POSTGRES_USER = os.environ.get("POSTGRES_USER", "postgres")
POSTGRES_PASSWORD = os.environ.get("POSTGRES_PASSWORD", "postgres")
POSTGRES_COLLECTION_NAME = os.environ.get("POSTGRES_COLLECTION_NAME", "memories")

NEO4J_URI = os.environ.get("NEO4J_URI", "bolt://neo4j:7687")
NEO4J_USERNAME = os.environ.get("NEO4J_USERNAME", "neo4j")
NEO4J_PASSWORD = os.environ.get("NEO4J_PASSWORD", "mem0graph")

MEMGRAPH_URI = os.environ.get("MEMGRAPH_URI", "bolt://localhost:7687")
MEMGRAPH_USERNAME = os.environ.get("MEMGRAPH_USERNAME", "memgraph")
MEMGRAPH_PASSWORD = os.environ.get("MEMGRAPH_PASSWORD", "mem0graph")

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
HISTORY_DB_PATH = os.environ.get("HISTORY_DB_PATH", "/app/history/history.db")

# Configurable model selection
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "openai")
LLM_MODEL = os.environ.get("LLM_MODEL", "gpt-4.1-mini")
LLM_TEMPERATURE = float(os.environ.get("LLM_TEMPERATURE", "0.2"))
EMBEDDER_PROVIDER = os.environ.get("EMBEDDER_PROVIDER", "openai")
EMBEDDER_MODEL = os.environ.get("EMBEDDER_MODEL", "text-embedding-3-small")

# Resolve API key per provider
LLM_API_KEYS = {
    "openai": OPENAI_API_KEY,
    "anthropic": ANTHROPIC_API_KEY,
}
LLM_API_KEY = LLM_API_KEYS.get(LLM_PROVIDER, os.environ.get(f"{LLM_PROVIDER.upper()}_API_KEY", OPENAI_API_KEY))

# Patch: Anthropic rejects temperature + top_p together.
# AnthropicConfig defaults both to 0.1; intercept at the API call boundary.
if LLM_PROVIDER == "anthropic":
    import json as _json
    from mem0.llms.anthropic import AnthropicLLM
    _orig_generate = AnthropicLLM.generate_response
    def _patched_generate(self, messages, response_format=None, tools=None, tool_choice="auto", **kwargs):
        orig_create = self.client.messages.create
        def _filtered_create(**api_kwargs):
            if "temperature" in api_kwargs and "top_p" in api_kwargs:
                del api_kwargs["top_p"]
            return orig_create(**api_kwargs)
        self.client.messages.create = _filtered_create
        try:
            result = _orig_generate(self, messages, response_format, tools, tool_choice, **kwargs)
            # If result is empty/None, check if Anthropic returned a tool_use block instead of text.
            # mem0 passes tools for fact extraction; Anthropic responds with tool_use blocks,
            # not text — causing "Expecting value" JSON parse errors downstream.
            if not result:
                # Re-call directly to inspect raw response
                import anthropic as _anthropic
                raw = orig_create(**{
                    k: v for k, v in {
                        "model": self.config.model,
                        "messages": [m for m in messages if m.get("role") != "system"],
                        "system": next((m["content"] for m in messages if m.get("role") == "system"), ""),
                        "tools": tools,
                        "tool_choice": tool_choice,
                        "max_tokens": self.config.max_tokens or 2000,
                        "temperature": self.config.temperature,
                    }.items() if v is not None
                })
                for block in raw.content:
                    if hasattr(block, "input"):  # tool_use block
                        return _json.dumps(block.input)
                    if hasattr(block, "text") and block.text:
                        return block.text
            return result
        finally:
            self.client.messages.create = orig_create
    AnthropicLLM.generate_response = _patched_generate

# Patch: OpenAI LLM _parse_response does a bare json.loads on tool_call.function.arguments
# which crashes when the model returns malformed JSON (common with long entity extraction).
# Wrap it to attempt repair and gracefully skip unrecoverable tool calls.
import json as _json
from mem0.llms.openai import OpenAILLM as _OpenAILLM
from mem0.memory.utils import extract_json as _extract_json

_orig_parse_response = _OpenAILLM._parse_response

def _safe_parse_response(self, response, tools):
    if not tools:
        return response.choices[0].message.content

    processed = {"content": response.choices[0].message.content, "tool_calls": []}
    if response.choices[0].message.tool_calls:
        for tool_call in response.choices[0].message.tool_calls:
            raw_args = _extract_json(tool_call.function.arguments)
            try:
                parsed = _json.loads(raw_args)
            except _json.JSONDecodeError:
                # Attempt basic repair: truncate to last complete JSON object/array
                repaired = _try_repair_json(raw_args)
                if repaired is not None:
                    parsed = repaired
                    logger.warning(f"Repaired malformed tool_call JSON for '{tool_call.function.name}'")
                else:
                    logger.warning(
                        f"Skipping tool_call '{tool_call.function.name}' — unrecoverable JSON: "
                        f"...{raw_args[-80:]}"
                    )
                    continue
            processed["tool_calls"].append({"name": tool_call.function.name, "arguments": parsed})
    return processed

def _try_repair_json(raw: str):
    """Attempt to salvage truncated or slightly malformed JSON."""
    # Strategy 1: the string is truncated mid-object — find last balanced closing brace
    for end_char in ('}', ']'):
        idx = raw.rfind(end_char)
        if idx > 0:
            candidate = raw[:idx + 1]
            try:
                return _json.loads(candidate)
            except _json.JSONDecodeError:
                pass
    return None

_OpenAILLM._parse_response = _safe_parse_response

# ---------------------------------------------------------------------------
# LLM call instrumentation — wrap generate_response to log latency and tokens
# ---------------------------------------------------------------------------
_orig_openai_generate = _OpenAILLM.generate_response

def _instrumented_openai_generate(self, messages, response_format=None, tools=None, tool_choice="auto"):
    _orig_create = self.client.chat.completions.create

    def _capturing_create(*args, **kwargs):
        resp = _orig_create(*args, **kwargs)
        self._last_response = resp
        return resp

    self.client.chat.completions.create = _capturing_create

    start = time.perf_counter()
    try:
        result = _orig_openai_generate(self, messages, response_format, tools, tool_choice)
        duration_ms = (time.perf_counter() - start) * 1000

        usage = {}
        if hasattr(self, '_last_response') and self._last_response:
            u = getattr(self._last_response, 'usage', None)
            if u:
                usage = {"prompt_tokens": u.prompt_tokens, "completion_tokens": u.completion_tokens}

        log_with_data(logging.DEBUG, "llm_call",
            provider="openai", model=self.config.model,
            has_tools=bool(tools),
            duration_ms=round(duration_ms, 1),
            **usage,
        )
        metrics.record("llm_call", duration_ms)
        return result
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        log_with_data(logging.ERROR, "llm_call_error",
            provider="openai", model=self.config.model,
            error=str(e),
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("llm_call", duration_ms, error=True)
        raise
    finally:
        self.client.chat.completions.create = _orig_create

_OpenAILLM.generate_response = _instrumented_openai_generate

# Graph store uses OpenAI-style tool calling internally (function format, string tool_choice,
# response.tool_calls parsing). Incompatible with Anthropic. Disable when using Anthropic.
ENABLE_GRAPH = os.environ.get("GRAPH_STORE_ENABLED", "true").lower() == "true"
if LLM_PROVIDER == "anthropic":
    ENABLE_GRAPH = False
    logger.info("Graph store disabled (incompatible with Anthropic tool calling format)")

# Patch: upstream sanitize_relationship_for_cypher uses a blocklist that misses ASCII commas,
# periods, hyphens, etc. Replace with allowlist — Cypher relationship types only permit [a-zA-Z0-9_].
import re as _re
import mem0.memory.utils as _mem0_utils
def _strict_sanitize(relationship: str) -> str:
    sanitized = _re.sub(r"[^a-zA-Z0-9_]", "_", relationship)
    sanitized = _re.sub(r"_+", "_", sanitized)
    return sanitized.strip("_")
_mem0_utils.sanitize_relationship_for_cypher = _strict_sanitize

# Patch: upstream _remove_spaces_from_entities crashes with KeyError when
# the LLM returns entities missing 'source', 'relationship', or 'destination'.
from mem0.memory.graph_memory import MemoryGraph as _MemoryGraph
def _coerce_to_str(value):
    """Coerce a value to string — LLM sometimes returns lists instead of strings."""
    if isinstance(value, list):
        return " ".join(str(v) for v in value)
    return str(value)

def _safe_remove_spaces(self, entity_list):
    cleaned = []
    for item in entity_list:
        # Fix LLM returning destination as a dynamic key, e.g. {'source': X, 'relationship': Y, '#18': '#18'}
        if "destination" not in item:
            extra_keys = set(item.keys()) - {"source", "relationship", "destination", "source_type", "destination_type"}
            if len(extra_keys) == 1 and "source" in item and "relationship" in item:
                bad_key = extra_keys.pop()
                item["destination"] = item.pop(bad_key)
                logger.info(f"Recovered malformed entity: mapped key '{bad_key}' to 'destination'")
        if not all(k in item for k in ("source", "relationship", "destination")):
            logger.warning(f"Skipping malformed entity (missing keys): {item}")
            continue
        item["source"] = _coerce_to_str(item["source"]).lower().replace(" ", "_")
        item["relationship"] = _strict_sanitize(_coerce_to_str(item["relationship"]).lower().replace(" ", "_"))
        item["destination"] = _coerce_to_str(item["destination"]).lower().replace(" ", "_")
        cleaned.append(item)
    return cleaned
_MemoryGraph._remove_spaces_from_entities = _safe_remove_spaces

log_with_data(logging.INFO, "Configuration loaded",
    llm_provider=LLM_PROVIDER, llm_model=LLM_MODEL,
    embedder_provider=EMBEDDER_PROVIDER, embedder_model=EMBEDDER_MODEL,
    graph_enabled=ENABLE_GRAPH,
)

DEFAULT_CONFIG = {
    "version": "v1.1",
    "vector_store": {
        "provider": "pgvector",
        "config": {
            "host": POSTGRES_HOST,
            "port": int(POSTGRES_PORT),
            "dbname": POSTGRES_DB,
            "user": POSTGRES_USER,
            "password": POSTGRES_PASSWORD,
            "collection_name": POSTGRES_COLLECTION_NAME,
        },
    },
    "llm": {"provider": LLM_PROVIDER, "config": {
        "api_key": LLM_API_KEY,
        "model": LLM_MODEL,
        "temperature": LLM_TEMPERATURE,
        **({"top_p": None} if LLM_PROVIDER == "anthropic" else {}),
    }},
    "embedder": {"provider": EMBEDDER_PROVIDER, "config": {"api_key": OPENAI_API_KEY, "model": EMBEDDER_MODEL}},
    "history_db_path": HISTORY_DB_PATH,
}

if ENABLE_GRAPH:
    DEFAULT_CONFIG["graph_store"] = {
        "provider": "neo4j",
        "config": {"url": NEO4J_URI, "username": NEO4J_USERNAME, "password": NEO4J_PASSWORD},
    }


MEMORY_INSTANCE = Memory.from_config(DEFAULT_CONFIG)

app = FastAPI(
    title="Mem0 REST APIs",
    description="A REST API for managing and searching memories for your AI Agents and Apps.",
    version="1.0.0",
)


# ---------------------------------------------------------------------------
# Request/response logging middleware
# ---------------------------------------------------------------------------
SKIP_LOG_PATHS = {"/health", "/", "/docs", "/openapi.json", "/favicon.ico"}

class ObservabilityMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        if request.url.path in SKIP_LOG_PATHS:
            return await call_next(request)

        request_id = str(uuid.uuid4())[:8]
        _request_id.set(request_id)
        start = time.perf_counter()

        response = await call_next(request)

        duration_ms = (time.perf_counter() - start) * 1000
        operation = f"{request.method} {request.url.path}"
        is_error = response.status_code >= 400

        metrics.record(operation, duration_ms, error=is_error)

        log_with_data(
            logging.WARNING if is_error else logging.INFO,
            f"{request.method} {request.url.path} → {response.status_code}",
            request_id=request_id,
            method=request.method,
            path=str(request.url.path),
            query=str(request.url.query) if request.url.query else None,
            status=response.status_code,
            duration_ms=round(duration_ms, 1),
        )
        return response


app.add_middleware(ObservabilityMiddleware)


class Message(BaseModel):
    role: str = Field(..., description="Role of the message (user or assistant).")
    content: str = Field(..., description="Message content.")


class MemoryCreate(BaseModel):
    messages: List[Message] = Field(..., description="List of messages to store.")
    user_id: Optional[str] = None
    agent_id: Optional[str] = None
    run_id: Optional[str] = None
    metadata: Optional[Dict[str, Any]] = None


class SearchRequest(BaseModel):
    query: str = Field(..., description="Search query.")
    user_id: Optional[str] = None
    run_id: Optional[str] = None
    agent_id: Optional[str] = None
    filters: Optional[Dict[str, Any]] = None


@app.post("/configure", summary="Configure Mem0")
def set_config(config: Dict[str, Any]):
    """Set memory configuration."""
    global MEMORY_INSTANCE
    MEMORY_INSTANCE = Memory.from_config(config)
    return {"message": "Configuration set successfully"}


@app.post("/memories", summary="Create memories")
def add_memory(memory_create: MemoryCreate):
    """Store new memories."""
    if not any([memory_create.user_id, memory_create.agent_id, memory_create.run_id]):
        raise HTTPException(status_code=400, detail="At least one identifier (user_id, agent_id, run_id) is required.")

    params = {k: v for k, v in memory_create.model_dump().items() if v is not None and k != "messages"}
    roles = [m.role for m in memory_create.messages]
    input_chars = sum(len(m.content) for m in memory_create.messages)

    start = time.perf_counter()
    try:
        response = MEMORY_INSTANCE.add(messages=[m.model_dump() for m in memory_create.messages], **params)
        duration_ms = (time.perf_counter() - start) * 1000

        facts_added = len(response.get("results", [])) if isinstance(response, dict) else 0
        relations = response.get("relations", {}) if isinstance(response, dict) else {}
        entities_added = len(relations.get("added_entities", []))
        entities_deleted = len(relations.get("deleted_entities", []))

        log_with_data(logging.INFO, "memory_add",
            user_id=memory_create.user_id,
            agent_id=memory_create.agent_id,
            roles=roles,
            input_chars=input_chars,
            facts_added=facts_added,
            entities_added=entities_added,
            entities_deleted=entities_deleted,
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("add_memory", duration_ms, user_id=memory_create.user_id)
        return JSONResponse(content=response)
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        log_with_data(logging.ERROR, "memory_add_error",
            user_id=memory_create.user_id,
            roles=roles,
            input_chars=input_chars,
            error=str(e),
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("add_memory", duration_ms, error=True, user_id=memory_create.user_id)
        logger.exception("Error in add_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories", summary="Get memories")
def get_all_memories(
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
    agent_id: Optional[str] = None,
    limit: int = 100,
):
    """Retrieve stored memories."""
    if not any([user_id, run_id, agent_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    start = time.perf_counter()
    try:
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        result = MEMORY_INSTANCE.get_all(**params, limit=limit)
        duration_ms = (time.perf_counter() - start) * 1000
        result_count = len(result.get("results", [])) if isinstance(result, dict) else 0

        log_with_data(logging.INFO, "memory_list",
            user_id=user_id, limit=limit,
            result_count=result_count,
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("list_memories", duration_ms, user_id=user_id)
        return result
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("list_memories", duration_ms, error=True, user_id=user_id)
        logger.exception("Error in get_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/count", summary="Count memories")
def count_memories(
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
    agent_id: Optional[str] = None,
):
    """Return total count of memories without the 100-result default limit."""
    if not any([user_id, run_id, agent_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    start = time.perf_counter()
    try:
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        result = MEMORY_INSTANCE.get_all(**params, limit=10000)
        memories = result.get("results", []) if isinstance(result, dict) else result
        relations = result.get("relations", []) if isinstance(result, dict) else []
        duration_ms = (time.perf_counter() - start) * 1000
        count = len(memories)
        rel_count = len(relations)

        log_with_data(logging.INFO, "memory_count",
            user_id=user_id, count=count, relations_count=rel_count,
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("count_memories", duration_ms, user_id=user_id)
        return {"count": count, "relations_count": rel_count}
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("count_memories", duration_ms, error=True, user_id=user_id)
        logger.exception("Error in count_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/{memory_id}", summary="Get a memory")
def get_memory(memory_id: str):
    """Retrieve a specific memory by ID."""
    start = time.perf_counter()
    try:
        result = MEMORY_INSTANCE.get(memory_id)
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("get_memory", duration_ms)
        return result
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("get_memory", duration_ms, error=True)
        logger.exception("Error in get_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search", summary="Search memories")
def search_memories(search_req: SearchRequest):
    """Search for memories based on a query."""
    start = time.perf_counter()
    try:
        params = {k: v for k, v in search_req.model_dump().items() if v is not None and k != "query"}
        result = MEMORY_INSTANCE.search(query=search_req.query, **params)
        duration_ms = (time.perf_counter() - start) * 1000

        result_count = len(result.get("results", [])) if isinstance(result, dict) else 0
        top_score = None
        if isinstance(result, dict) and result.get("results"):
            top_score = result["results"][0].get("score")

        log_with_data(logging.INFO, "memory_search",
            user_id=search_req.user_id,
            query=search_req.query[:100],
            result_count=result_count,
            top_score=round(top_score, 3) if top_score is not None else None,
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("search_memory", duration_ms, user_id=search_req.user_id)
        return result
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("search_memory", duration_ms, error=True, user_id=search_req.user_id)
        logger.exception("Error in search_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/memories/{memory_id}", summary="Update a memory")
def update_memory(memory_id: str, updated_memory: Dict[str, Any]):
    """Update an existing memory with new content."""
    start = time.perf_counter()
    try:
        data = updated_memory.get("data") or updated_memory.get("text") or updated_memory.get("memory")
        if not data or not isinstance(data, str):
            raise HTTPException(status_code=400, detail="Request body must include 'data', 'text', or 'memory' string field")
        result = MEMORY_INSTANCE.update(memory_id=memory_id, data=data)
        duration_ms = (time.perf_counter() - start) * 1000

        log_with_data(logging.INFO, "memory_update",
            memory_id=memory_id, input_chars=len(data),
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("update_memory", duration_ms)
        return result
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("update_memory", duration_ms, error=True)
        logger.exception("Error in update_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/memories/{memory_id}/history", summary="Get memory history")
def memory_history(memory_id: str):
    """Retrieve memory history."""
    start = time.perf_counter()
    try:
        result = MEMORY_INSTANCE.history(memory_id=memory_id)
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("memory_history", duration_ms)
        return result
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("memory_history", duration_ms, error=True)
        logger.exception("Error in memory_history:")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories/{memory_id}", summary="Delete a memory")
def delete_memory(memory_id: str):
    """Delete a specific memory by ID."""
    start = time.perf_counter()
    try:
        MEMORY_INSTANCE.delete(memory_id=memory_id)
        duration_ms = (time.perf_counter() - start) * 1000

        log_with_data(logging.INFO, "memory_delete",
            memory_id=memory_id,
            duration_ms=round(duration_ms, 1),
        )
        metrics.record("delete_memory", duration_ms)
        return {"message": "Memory deleted successfully"}
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("delete_memory", duration_ms, error=True)
        logger.exception("Error in delete_memory:")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/memories", summary="Delete all memories")
def delete_all_memories(
    user_id: Optional[str] = None,
    run_id: Optional[str] = None,
    agent_id: Optional[str] = None,
):
    """Delete all memories for a given identifier."""
    if not any([user_id, run_id, agent_id]):
        raise HTTPException(status_code=400, detail="At least one identifier is required.")
    start = time.perf_counter()
    try:
        params = {
            k: v for k, v in {"user_id": user_id, "run_id": run_id, "agent_id": agent_id}.items() if v is not None
        }
        MEMORY_INSTANCE.delete_all(**params)
        duration_ms = (time.perf_counter() - start) * 1000

        log_with_data(logging.WARNING, "memory_delete_all",
            **params, duration_ms=round(duration_ms, 1),
        )
        metrics.record("delete_all", duration_ms, user_id=user_id)
        return {"message": "All relevant memories deleted"}
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("delete_all", duration_ms, error=True, user_id=user_id)
        logger.exception("Error in delete_all_memories:")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reset", summary="Reset all memories")
def reset_memory():
    """Completely reset stored memories."""
    start = time.perf_counter()
    try:
        MEMORY_INSTANCE.reset()
        duration_ms = (time.perf_counter() - start) * 1000
        log_with_data(logging.WARNING, "memory_reset", duration_ms=round(duration_ms, 1))
        metrics.record("reset", duration_ms)
        return {"message": "All memories reset"}
    except Exception as e:
        duration_ms = (time.perf_counter() - start) * 1000
        metrics.record("reset", duration_ms, error=True)
        logger.exception("Error in reset_memory:")
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Metrics endpoint — GET /metrics for throughput/latency dashboard
# ---------------------------------------------------------------------------
@app.get("/metrics", summary="Throughput and latency metrics")
def get_metrics():
    """Return per-operation counts, error rates, avg latency, and RPM."""
    return metrics.snapshot()


@app.get("/metrics/users", summary="Per-user memory metrics")
def get_user_metrics():
    """Return per-user memory counts from postgres + per-user operation counts."""
    import psycopg
    dsn = f"host={POSTGRES_HOST} port={POSTGRES_PORT} dbname={POSTGRES_DB} user={POSTGRES_USER} password={POSTGRES_PASSWORD}"
    try:
        with psycopg.connect(dsn) as conn:
            with conn.cursor() as cur:
                cur.execute("""
                    SELECT
                        payload->>'user_id' AS user_id,
                        COUNT(*) AS memory_count
                    FROM {}
                    WHERE payload->>'user_id' IS NOT NULL
                    GROUP BY payload->>'user_id'
                    ORDER BY memory_count DESC
                """.format(POSTGRES_COLLECTION_NAME))
                rows = cur.fetchall()

        store_counts = {row[0]: row[1] for row in rows}
    except Exception as e:
        logger.warning(f"Failed to query postgres for user counts: {e}")
        store_counts = {}

    throughput = metrics.user_snapshot()

    users = {}
    for uid in set(list(store_counts.keys()) + list(throughput.keys())):
        users[uid] = {
            "memories": store_counts.get(uid, 0),
            "operations": throughput.get(uid, {}),
        }

    return {"users": users}


@app.get("/health", summary="Health check", include_in_schema=False)
def health():
    """Health check endpoint for container orchestration."""
    return {"status": "ok"}


@app.get("/", summary="Redirect to the OpenAPI documentation", include_in_schema=False)
def home():
    """Redirect to the OpenAPI documentation."""
    return RedirectResponse(url="/docs")


# ---------------------------------------------------------------------------
# Versioned path aliases — clients (openclaw-mem0, MCP tools) try /v1/ and
# /v2/ prefixed paths.  Route them to the canonical handlers above so callers
# don't need fallback chains.
# ---------------------------------------------------------------------------
app.post("/v1/memories", include_in_schema=False)(add_memory)
app.post("/v2/memories", include_in_schema=False)(add_memory)
app.get("/v1/memories", include_in_schema=False)(get_all_memories)
app.get("/v2/memories", include_in_schema=False)(get_all_memories)
app.post("/v1/memories/search", include_in_schema=False)(search_memories)
app.post("/v2/memories/search", include_in_schema=False)(search_memories)
app.post("/v1/search", include_in_schema=False)(search_memories)
app.post("/v2/search", include_in_schema=False)(search_memories)
app.get("/v1/memories/{memory_id}", include_in_schema=False)(get_memory)
app.get("/v2/memories/{memory_id}", include_in_schema=False)(get_memory)
app.put("/v1/memories/{memory_id}", include_in_schema=False)(update_memory)
app.put("/v2/memories/{memory_id}", include_in_schema=False)(update_memory)
app.delete("/v1/memories/{memory_id}", include_in_schema=False)(delete_memory)
app.delete("/v2/memories/{memory_id}", include_in_schema=False)(delete_memory)
app.get("/v1/memories/{memory_id}/history", include_in_schema=False)(memory_history)
app.get("/v2/memories/{memory_id}/history", include_in_schema=False)(memory_history)

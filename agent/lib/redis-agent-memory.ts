import { createHash } from "node:crypto";
import { defineMemoryProvider, type MemoryOperationContext, type MemoryToolSet } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * eve memory provider backed by Redis Agent Memory (Redis Cloud / Redis Iris).
 *
 * Data Plane API: `${url}/iris/data/v1/agent-memory/stores/${storeId}`
 * Docs: https://redis.io/docs/latest/develop/ai/context-engine/agent-memory/
 *
 * Per turn:
 * 1. recall (turn.started): semantic search over the owner's long-term memory.
 *    The user's message is then appended to session memory as a USER event whose
 *    `metadata.recall` records exactly which memories were handed to the model.
 * 2. capture (turn.completed): the assistant reply is appended as an ASSISTANT
 *    event. Redis Agent Memory extracts durable long-term memories from session
 *    events in the background.
 * 3. tools: search / save / forget long-term memories for the owner.
 *
 * The owner defaults to the eve scope key. Pass `ownerId` to pin a fixed owner
 * (single-user apps), which also lets other services (the web UI) address the
 * same owner and session IDs.
 */

type ModelMessage = MemoryOperationContext["messages"][number];

export interface RedisAgentMemoryOptions {
  /** Base URL of the Agent Memory service. Defaults to `IRIS_AGENT_MEMORY_URL`. */
  url?: string;
  /** Agent Memory store ID. Defaults to `IRIS_AGENT_MEMORY_STORE_ID`. */
  storeId?: string;
  /** Agent Memory API key. Defaults to `IRIS_AGENT_MEMORY_API_KEY`. */
  apiKey?: string;
  /**
   * Fixed Agent Memory `ownerId`. Defaults to the eve scope key, which keeps
   * every scope isolated. Only pin it when the app has a single user.
   */
  ownerId?: string;
  /** Number of memories recalled before each turn. Default 5. */
  topK?: number;
  /** Append turns to session memory for automatic extraction. Default true. */
  captureTurns?: boolean;
  /** `actorId` recorded on assistant session events. Default "eve-agent". */
  assistantId?: string;
  /** Per-request timeout in milliseconds. Default 10000. */
  timeoutMs?: number;
  /**
   * When true (default), recall and tool-discovery failures are logged and the
   * turn continues without memory instead of failing. eve fails the whole turn
   * when recall or tools() throws, which also blocks self-modification.
   */
  failOpen?: boolean;
}

interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  topK: number;
  captureTurns: boolean;
  assistantId: string;
  timeoutMs: number;
  failOpen: boolean;
}

interface LongTermMemory {
  memoryId: string;
  text: string;
  ownerId?: string;
  memoryType?: string;
  topics?: string[];
}

interface SearchResponse {
  items?: LongTermMemory[];
}

/** Shape of `metadata.recall` on USER session events written by this provider. */
export interface RecallRecord {
  query: string;
  topK: number;
  status: "ok" | "error";
  memories: { memoryId: string; text: string; memoryType?: string; topics?: string[] }[];
}

export class RedisAgentMemoryError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "RedisAgentMemoryError";
    this.status = status;
  }
}

const LOG_PREFIX = "[redis-agent-memory]";
const MAX_QUERY_CHARS = 2000;
const MAX_EVENT_CHARS = 16000;

function resolveConfig(options: RedisAgentMemoryOptions): ResolvedConfig | null {
  const url = (options.url ?? process.env.IRIS_AGENT_MEMORY_URL ?? "").trim();
  const storeId = (options.storeId ?? process.env.IRIS_AGENT_MEMORY_STORE_ID ?? "").trim();
  const apiKey = (options.apiKey ?? process.env.IRIS_AGENT_MEMORY_API_KEY ?? "").trim();
  if (!url || !storeId || !apiKey) return null;
  return {
    baseUrl: `${url.replace(/\/+$/, "")}/iris/data/v1/agent-memory/stores/${encodeURIComponent(storeId)}`,
    apiKey,
    topK: Math.min(Math.max(Math.trunc(options.topK ?? 5), 1), 100),
    captureTurns: options.captureTurns ?? true,
    assistantId: options.assistantId ?? "eve-agent",
    timeoutMs: options.timeoutMs ?? 10_000,
    failOpen: options.failOpen ?? true,
  };
}

function digest(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/**
 * Agent Memory session ID for an eve session. Stable and URL-safe.
 * Keep in sync with `apps/web/lib/agent-memory.ts`.
 */
export function redisSessionIdFor(ownerId: string, eveSessionId: string): string {
  return `eve-${digest(ownerId, eveSessionId).slice(0, 40)}`;
}

function textOf(message: ModelMessage): string {
  const { content } = message;
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}

function createClient(config: ResolvedConfig) {
  async function request<T>(
    method: string,
    path: string,
    signal: AbortSignal,
    body?: unknown,
  ): Promise<T | null> {
    const response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs)]),
    });
    if (response.status === 404 && method === "GET") return null;
    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new RedisAgentMemoryError(
        `Redis Agent Memory ${method} ${path} failed with ${response.status}${detail ? `: ${detail}` : ""}`,
        response.status,
      );
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? (JSON.parse(text) as T) : null;
  }

  return {
    async search(ownerId: string, query: string | undefined, limit: number, signal: AbortSignal) {
      const result = await request<SearchResponse>("POST", "/memories/search", signal, {
        ...(query ? { query: query.slice(0, MAX_QUERY_CHARS) } : {}),
        filter: { ownerId: { eq: ownerId } },
        limit,
        ...(query ? {} : { sortBy: "updatedAt", sortOrder: "DESC" }),
      });
      return result?.items ?? [];
    },

    async create(ownerId: string, text: string, topics: string[], signal: AbortSignal) {
      const memoryId = `eve-${digest(ownerId, text).slice(0, 40)}`;
      await request("POST", "/memories", signal, {
        idempotencyKey: digest("create", memoryId),
        memories: [{ memoryId, text, ownerId, ...(topics.length ? { topics } : {}) }],
      });
      return memoryId;
    },

    async get(memoryId: string, signal: AbortSignal) {
      return request<LongTermMemory>("GET", `/memories/${encodeURIComponent(memoryId)}`, signal);
    },

    async remove(memoryIds: string[], signal: AbortSignal) {
      await request("POST", "/memories/bulk-delete", signal, { memoryIds });
    },

    async appendEvent(
      sessionId: string,
      event: {
        actorId: string;
        role: "USER" | "ASSISTANT";
        text: string;
        idempotencyKey: string;
        metadata?: Record<string, unknown>;
      },
      signal: AbortSignal,
    ) {
      await request("POST", `/sessions/${encodeURIComponent(sessionId)}/events`, signal, {
        actorId: event.actorId,
        role: event.role,
        content: [{ text: event.text.slice(0, MAX_EVENT_CHARS) }],
        createdAt: new Date().toISOString(),
        idempotencyKey: event.idempotencyKey,
        ...(event.metadata ? { metadata: event.metadata } : {}),
      });
    },
  };
}

export function redisAgentMemory(options: RedisAgentMemoryOptions = {}) {
  let warnedUnconfigured = false;

  function config(): ResolvedConfig | null {
    const resolved = resolveConfig(options);
    if (!resolved && !warnedUnconfigured) {
      warnedUnconfigured = true;
      console.warn(
        `${LOG_PREFIX} IRIS_AGENT_MEMORY_URL, IRIS_AGENT_MEMORY_STORE_ID, and IRIS_AGENT_MEMORY_API_KEY must all be set. Memory is disabled until they are.`,
      );
    }
    return resolved;
  }

  const ownerOf = (scopeKey: string) => options.ownerId ?? scopeKey;

  return defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const cfg = config();
        if (!cfg) return null;
        const query = ctx.turn.input
          .filter((message) => message.role === "user")
          .map(textOf)
          .join("\n")
          .trim();
        if (!query) return null;

        const client = createClient(cfg);
        const ownerId = ownerOf(ctx.memory.scope.key);
        let items: LongTermMemory[] = [];
        let status: RecallRecord["status"] = "ok";
        try {
          items = await client.search(ownerId, query, cfg.topK, ctx.abortSignal);
        } catch (error) {
          if (isAbort(error, ctx.abortSignal) || !cfg.failOpen) throw error;
          status = "error";
          console.warn(`${LOG_PREFIX} recall failed; continuing without memory.`, String(error));
        }

        // Record the user's message in session memory together with what recall
        // returned, so the conversation history in Redis shows what the model saw.
        if (cfg.captureTurns) {
          const recall: RecallRecord = {
            query: query.slice(0, MAX_QUERY_CHARS),
            topK: cfg.topK,
            status,
            memories: items.map(({ memoryId, text, memoryType, topics }) => ({
              memoryId,
              text,
              ...(memoryType ? { memoryType } : {}),
              ...(topics?.length ? { topics } : {}),
            })),
          };
          try {
            await client.appendEvent(
              redisSessionIdFor(ownerId, ctx.session.id),
              {
                actorId: ownerId,
                role: "USER",
                text: query,
                idempotencyKey: digest(ctx.operationId, "user"),
                metadata: { source: "eve", eveTurnId: ctx.turn.id, recall },
              },
              ctx.abortSignal,
            );
          } catch (error) {
            if (isAbort(error, ctx.abortSignal) || !cfg.failOpen) throw error;
            console.warn(`${LOG_PREFIX} failed to record user event.`, String(error));
          }
        }

        if (items.length === 0) return null;
        return {
          messages: items.map((item) => ({
            id: `redis-agent-memory:${item.memoryId}`,
            content: `[memory ${item.memoryId}] ${item.text}`,
          })),
        };
      },
    },

    capture: {
      async "turn.completed"(ctx) {
        const cfg = config();
        if (!cfg || !cfg.captureTurns) return;
        const lastAssistant = [...ctx.messages].reverse().find((m) => m.role === "assistant");
        const assistantText = lastAssistant ? textOf(lastAssistant).trim() : "";
        if (!assistantText) return;
        const ownerId = ownerOf(ctx.memory.scope.key);
        await createClient(cfg).appendEvent(
          redisSessionIdFor(ownerId, ctx.session.id),
          {
            actorId: cfg.assistantId,
            role: "ASSISTANT",
            text: assistantText,
            idempotencyKey: digest(ctx.operationId, "assistant"),
            metadata: { source: "eve", eveTurnId: ctx.turn.id },
          },
          ctx.abortSignal,
        );
      },
    },

    async tools(ctx) {
      const cfg = config();
      if (!cfg) return null;
      const client = createClient(cfg);
      const ownerId = ownerOf(ctx.memory.scope.key);

      const tools: MemoryToolSet = {
        search_memory: defineTool({
          description:
            "Search long-term memory for facts and preferences about the current user. Omit query to list the most recent memories.",
          inputSchema: z.object({
            query: z.string().min(1).optional(),
            limit: z.number().int().min(1).max(20).optional(),
          }),
          async execute({ query, limit }, { abortSignal }) {
            const items = await client.search(ownerId, query, limit ?? 10, abortSignal);
            return {
              memories: items.map(({ memoryId, text, topics }) => ({ memoryId, text, topics })),
            };
          },
        }),

        save_memory: defineTool({
          description:
            "Save one concise, durable fact or preference about the user for future conversations. Never save secrets or credentials.",
          inputSchema: z.object({
            text: z.string().min(1).max(2000),
            topics: z.array(z.string().min(1).max(64)).max(10).optional(),
          }),
          async execute({ text, topics }, { abortSignal }) {
            const memoryId = await client.create(ownerId, text.trim(), topics ?? [], abortSignal);
            return { saved: true, memoryId };
          },
        }),

        forget_memory: defineTool({
          description:
            "Delete a long-term memory by the memory ID shown in recalled or searched memory.",
          inputSchema: z.object({ memoryId: z.string().min(1) }),
          async execute({ memoryId }, { abortSignal }) {
            const existing = await client.get(memoryId, abortSignal);
            // The model chooses the ID, so enforce ownership before deleting.
            if (!existing || existing.ownerId !== ownerId)
              return { deleted: false, reason: "not found" };
            await client.remove([memoryId], abortSignal);
            return { deleted: true };
          },
        }),
      };
      return tools;
    },
  });
}

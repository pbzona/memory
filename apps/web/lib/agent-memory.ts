import { createHash } from "node:crypto";
import { containsBlockedLanguage, redactBlockedLanguage } from "./content-filter";

/**
 * Server-only, read-only client for Redis Agent Memory, used by the memory
 * panel. Never import this from a client component: it reads the API key.
 *
 * The owner and session-ID derivation must match the agent's provider in
 * `agent/lib/redis-agent-memory.ts` and `agent/memory/redis-agent-memory.ts`.
 */

export const OWNER_ID = process.env.AGENT_MEMORY_OWNER_ID?.trim() || "showcase-user";

export interface RecalledMemory {
  memoryId: string;
  text: string;
  memoryType?: string;
  topics?: string[];
}

export interface RecallRecord {
  query: string;
  topK: number;
  status: "ok" | "error";
  memories: RecalledMemory[];
}

export interface SessionEvent {
  eventId: string;
  role: "USER" | "ASSISTANT" | "SYSTEM" | string;
  actorId: string;
  text: string;
  createdAt: string;
  recall?: RecallRecord;
}

export interface LongTermMemory {
  memoryId: string;
  text: string;
  memoryType: string;
  topics: string[];
  sessionId?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface MemorySnapshot {
  configured: boolean;
  ownerId: string;
  health?: { status: string; features: Record<string, string> };
  memories: LongTermMemory[];
  session?: {
    sessionId: string;
    summary?: string;
    events: SessionEvent[];
  };
  error?: string;
}

function config() {
  const url = process.env.IRIS_AGENT_MEMORY_URL?.trim();
  const storeId = process.env.IRIS_AGENT_MEMORY_STORE_ID?.trim();
  const apiKey = process.env.IRIS_AGENT_MEMORY_API_KEY?.trim();
  if (!url || !storeId || !apiKey) return null;
  return {
    baseUrl: `${url.replace(/\/+$/, "")}/iris/data/v1/agent-memory/stores/${encodeURIComponent(storeId)}`,
    apiKey,
  };
}

/** Same derivation as `redisSessionIdFor` in the agent's provider. */
export function redisSessionIdFor(eveSessionId: string): string {
  const hash = createHash("sha256").update(`${OWNER_ID}\u0000${eveSessionId}`).digest("hex");
  return `eve-${hash.slice(0, 40)}`;
}

async function request<T>(
  cfg: NonNullable<ReturnType<typeof config>>,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T | null> {
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(8000),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Redis Agent Memory ${method} ${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

type RawContent = { text?: string }[] | undefined;
const joinText = (content: RawContent) =>
  (content ?? [])
    .map((part) => part.text ?? "")
    .filter(Boolean)
    .join("\n");

function asRecall(value: unknown): RecallRecord | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<RecallRecord>;
  if (!Array.isArray(record.memories)) return undefined;
  return {
    query: redactBlockedLanguage(String(record.query ?? "")),
    topK: Number(record.topK ?? 0),
    status: record.status === "error" ? "error" : "ok",
    memories: record.memories.filter(
      (memory): memory is RecalledMemory =>
        typeof memory?.memoryId === "string" &&
        typeof memory?.text === "string" &&
        !containsBlockedLanguage(memory.text),
    ),
  };
}

export async function readMemorySnapshot(eveSessionId?: string): Promise<MemorySnapshot> {
  const cfg = config();
  if (!cfg) return { configured: false, ownerId: OWNER_ID, memories: [] };

  try {
    const [health, search, session] = await Promise.all([
      request<{ status: string; features?: Record<string, { status: string }> }>(
        cfg,
        "GET",
        "/health",
      ),
      request<{ items?: Record<string, unknown>[] }>(cfg, "POST", "/memories/search", {
        filter: { ownerId: { eq: OWNER_ID } },
        sortBy: "updatedAt",
        sortOrder: "DESC",
        limit: 50,
      }),
      eveSessionId
        ? request<{
            summary?: { text?: string };
            events?: {
              eventId: string;
              role: string;
              actorId: string;
              content?: RawContent;
              createdAt: string;
              metadata?: { recall?: unknown };
            }[];
          }>(cfg, "GET", `/sessions/${encodeURIComponent(redisSessionIdFor(eveSessionId))}`)
        : Promise.resolve(null),
    ]);

    return {
      configured: true,
      ownerId: OWNER_ID,
      health: health
        ? {
            status: health.status,
            features: Object.fromEntries(
              Object.entries(health.features ?? {}).map(([name, feature]) => [
                name,
                feature.status,
              ]),
            ),
          }
        : undefined,
      // This panel is public: hide any memory with blocked language, even one
      // stored before the filter existed.
      memories: (search?.items ?? [])
        .map((item) => ({
          memoryId: String(item.memoryId),
          text: String(item.text ?? ""),
          memoryType: String(item.memoryType ?? "semantic"),
          topics: Array.isArray(item.topics) ? item.topics.map(String) : [],
          sessionId: typeof item.sessionId === "string" ? item.sessionId : undefined,
          createdAt: typeof item.createdAt === "string" ? item.createdAt : undefined,
          updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : undefined,
        }))
        .filter((memory) => !containsBlockedLanguage([memory.text, ...memory.topics].join("\n"))),
      session:
        eveSessionId === undefined
          ? undefined
          : {
              sessionId: redisSessionIdFor(eveSessionId),
              summary: session?.summary?.text
                ? redactBlockedLanguage(session.summary.text)
                : undefined,
              events: (session?.events ?? []).map((event) => ({
                eventId: event.eventId,
                role: event.role,
                actorId: event.actorId,
                text: redactBlockedLanguage(joinText(event.content)),
                createdAt: event.createdAt,
                recall: asRecall(event.metadata?.recall),
              })),
            },
    };
  } catch (error) {
    return {
      configured: true,
      ownerId: OWNER_ID,
      memories: [],
      error: error instanceof Error ? error.message : "Unable to reach Redis Agent Memory.",
    };
  }
}

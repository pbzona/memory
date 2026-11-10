"use client";

import {
  BookmarkIcon,
  DatabaseIcon,
  MessagesSquareIcon,
  SearchIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LongTermMemory, MemorySnapshot, SessionEvent } from "@/lib/agent-memory";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const POLL_MS = 4000;
const HIGHLIGHT_MS = 8000;

/**
 * Live view of Redis Agent Memory for this chat. Everything here is read from
 * Redis Agent Memory itself through `/api/memory`. "Recalled" comes from the
 * metadata the agent's memory provider writes on each user session event, so it
 * shows exactly what was handed to the model before it replied.
 */
export function MemoryPanel({
  sessionId,
  refreshKey,
  onClose,
  className,
}: {
  readonly sessionId?: string;
  /** Changes when a turn starts or finishes, to refresh right away. */
  readonly refreshKey: string;
  readonly onClose?: () => void;
  readonly className?: string;
}) {
  const [snapshot, setSnapshot] = useState<MemorySnapshot>();
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const seen = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : "";
        const response = await fetch(`/api/memory${query}`, { cache: "no-store" });
        const next = (await response.json()) as MemorySnapshot;
        if (cancelled) return;
        setSnapshot(next);
        const ids = next.memories.map((memory) => memory.memoryId);
        if (seen.current === undefined) {
          seen.current = new Set(ids);
          return;
        }
        const added = ids.filter((id) => !seen.current!.has(id));
        if (added.length > 0) {
          for (const id of added) seen.current.add(id);
          setFresh((current) => new Set([...current, ...added]));
          setTimeout(() => {
            setFresh((current) => new Set([...current].filter((id) => !added.includes(id))));
          }, HIGHLIGHT_MS);
        }
      } catch {
        // Keep the last snapshot; the next poll retries.
      }
    };
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [sessionId, refreshKey]);

  const events = snapshot?.session?.events ?? [];
  const lastRecall = [...events].reverse().find((event) => event.role === "USER" && event.recall);

  return (
    <aside className={cn("flex h-full flex-col border-border border-l bg-card", className)}>
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b px-4">
        <DatabaseIcon className="size-4 text-red-600" />
        <h2 className="font-medium text-sm">Redis Agent Memory</h2>
        <StatusPill snapshot={snapshot} />
        {onClose ? (
          <Button
            aria-label="Close memory panel"
            className="ml-auto"
            onClick={onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            <XIcon className="size-4" />
          </Button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-4 text-sm">
        {snapshot && !snapshot.configured ? (
          <Notice>
            Set <code>IRIS_AGENT_MEMORY_URL</code>, <code>IRIS_AGENT_MEMORY_STORE_ID</code>, and{" "}
            <code>IRIS_AGENT_MEMORY_API_KEY</code> to connect a store.
          </Notice>
        ) : null}
        {snapshot?.error ? <Notice tone="error">{snapshot.error}</Notice> : null}

        <Section
          icon={<SearchIcon />}
          title="Recalled for your last message"
          hint="Before every reply, the agent runs a semantic search over long-term memory and adds the matches to the model's context."
        >
          {lastRecall?.recall ? (
            lastRecall.recall.status === "error" ? (
              <Empty>Recall failed for this message, so the agent replied without memory.</Empty>
            ) : lastRecall.recall.memories.length === 0 ? (
              <Empty>
                No memories matched &ldquo;{truncate(lastRecall.recall.query, 80)}&rdquo;. The agent
                replied without recalled context.
              </Empty>
            ) : (
              <ul className="space-y-2">
                {lastRecall.recall.memories.map((memory) => (
                  <li
                    className="rounded-md border border-red-600/25 bg-red-600/5 px-3 py-2"
                    key={memory.memoryId}
                  >
                    <p>{memory.text}</p>
                    <MemoryMeta
                      id={memory.memoryId}
                      topics={memory.topics}
                      type={memory.memoryType}
                    />
                  </li>
                ))}
              </ul>
            )
          ) : (
            <Empty>Send a message to see what the agent recalls.</Empty>
          )}
        </Section>

        <Section
          icon={<SparklesIcon />}
          title={`Long-term memory${snapshot ? ` (${snapshot.memories.length})` : ""}`}
          hint="Durable facts, shared across every chat. Redis Agent Memory extracts them from session memory in the background, so new ones appear a little after you mention them. Memories the agent saves with save_memory appear right away."
        >
          {snapshot === undefined ? (
            <Empty>Loading…</Empty>
          ) : snapshot.memories.length === 0 ? (
            <Empty>
              Nothing yet. Tell the agent about yourself, like where you live or what you like to
              eat.
            </Empty>
          ) : (
            <ul className="space-y-2">
              {snapshot.memories.map((memory) => (
                <LongTermMemoryItem
                  currentSession={snapshot.session?.sessionId}
                  fresh={fresh.has(memory.memoryId)}
                  key={memory.memoryId}
                  memory={memory}
                />
              ))}
            </ul>
          )}
        </Section>

        <Section
          icon={<MessagesSquareIcon />}
          title={`Session memory${snapshot?.session ? ` (${events.length} events)` : ""}`}
          hint="This chat's ordered message history as stored in Redis Agent Memory. Older events are summarized automatically when the conversation grows."
        >
          {snapshot?.session === undefined ? (
            <Empty>A session is created in Redis Agent Memory with your first message.</Empty>
          ) : (
            <>
              {snapshot.session.summary ? (
                <div className="mb-2 rounded-md bg-muted px-3 py-2">
                  <p className="mb-1 font-medium text-muted-foreground text-xs uppercase tracking-wide">
                    Summary
                  </p>
                  <p>{snapshot.session.summary}</p>
                </div>
              ) : null}
              {events.length === 0 ? (
                <Empty>No events stored yet.</Empty>
              ) : (
                <ol className="space-y-1.5">
                  {events.map((event) => (
                    <SessionEventItem event={event} key={event.eventId} />
                  ))}
                </ol>
              )}
              <p className="mt-2 truncate font-mono text-muted-foreground text-xs">
                {snapshot.session.sessionId}
              </p>
            </>
          )}
        </Section>

        <HowItWorks />
      </div>
    </aside>
  );
}

function StatusPill({ snapshot }: { readonly snapshot?: MemorySnapshot }) {
  const status = !snapshot
    ? { label: "Connecting", color: "bg-muted-foreground" }
    : !snapshot.configured
      ? { label: "Not configured", color: "bg-amber-500" }
      : snapshot.error || snapshot.health?.status !== "HEALTHY"
        ? { label: snapshot.health?.status ?? "Unreachable", color: "bg-destructive" }
        : { label: "Healthy", color: "bg-emerald-500" };
  const features = snapshot?.health?.features;
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-muted-foreground text-xs"
      title={
        features
          ? Object.entries(features)
              .map(([name, value]) => `${name}: ${value}`)
              .join("\n")
          : undefined
      }
    >
      <span className={cn("size-1.5 rounded-full", status.color)} />
      {status.label}
    </span>
  );
}

function Section({
  icon,
  title,
  hint,
  children,
}: {
  readonly icon: ReactNode;
  readonly title: string;
  readonly hint: string;
  readonly children: ReactNode;
}) {
  return (
    <section>
      <h3 className="flex items-center gap-2 font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
        {icon}
        {title}
      </h3>
      <p className="mt-1 mb-3 text-muted-foreground text-xs leading-relaxed">{hint}</p>
      {children}
    </section>
  );
}

function LongTermMemoryItem({
  memory,
  fresh,
  currentSession,
}: {
  readonly memory: LongTermMemory;
  readonly fresh: boolean;
  readonly currentSession?: string;
}) {
  const savedByTool = memory.memoryId.startsWith("eve-");
  const source = savedByTool
    ? "Saved by the agent"
    : memory.sessionId && memory.sessionId === currentSession
      ? "Extracted from this chat"
      : "Extracted automatically";
  return (
    <li
      className={cn(
        "rounded-md border px-3 py-2 transition-colors duration-700",
        fresh ? "border-emerald-500/50 bg-emerald-500/10" : "border-border",
      )}
    >
      <p>{memory.text}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-muted-foreground text-xs">
        <span className="inline-flex items-center gap-1">
          {savedByTool ? <BookmarkIcon className="size-3" /> : <SparklesIcon className="size-3" />}
          {source}
        </span>
        {fresh ? <span className="font-medium text-emerald-600">New</span> : null}
        {memory.updatedAt ? <span>· {relativeTime(memory.updatedAt)}</span> : null}
      </div>
      <MemoryMeta id={memory.memoryId} topics={memory.topics} type={memory.memoryType} />
    </li>
  );
}

function MemoryMeta({
  id,
  type,
  topics,
}: {
  readonly id: string;
  readonly type?: string;
  readonly topics?: readonly string[];
}) {
  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
      {type ? (
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{type}</span>
      ) : null}
      {(topics ?? []).map((topic) => (
        <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground" key={topic}>
          #{topic}
        </span>
      ))}
      <span className="truncate font-mono text-[10px] text-muted-foreground/70" title={id}>
        {id}
      </span>
    </div>
  );
}

function SessionEventItem({ event }: { readonly event: SessionEvent }) {
  const isUser = event.role === "USER";
  return (
    <li className="flex gap-2">
      <span
        className={cn(
          "mt-0.5 h-fit shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px]",
          isUser ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
        )}
      >
        {event.role}
      </span>
      <div className="min-w-0">
        <p className="line-clamp-2 text-xs">{event.text}</p>
        {event.recall ? (
          <p className="text-[11px] text-muted-foreground">
            {event.recall.status === "error"
              ? "recall failed"
              : `recalled ${event.recall.memories.length} ${event.recall.memories.length === 1 ? "memory" : "memories"}`}
          </p>
        ) : null}
      </div>
    </li>
  );
}

function HowItWorks() {
  const steps = [
    ["Recall", "Semantic search over long-term memory before the model runs."],
    ["Record", "Your message and the agent's reply are appended to session memory."],
    ["Extract", "Redis Agent Memory turns session events into durable memories in the background."],
    ["Reuse", "Future chats recall those memories, even after this session expires."],
  ] as const;
  return (
    <section className="rounded-md bg-muted/60 px-3 py-3">
      <h3 className="mb-2 font-medium text-xs uppercase tracking-wide text-muted-foreground">
        How it works
      </h3>
      <ol className="space-y-1.5 text-xs">
        {steps.map(([title, body], index) => (
          <li className="flex gap-2" key={title}>
            <span className="font-mono text-muted-foreground">{index + 1}</span>
            <span>
              <span className="font-medium">{title}.</span>{" "}
              <span className="text-muted-foreground">{body}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Notice({ children, tone }: { readonly children: ReactNode; readonly tone?: "error" }) {
  return (
    <p
      className={cn(
        "rounded-md border px-3 py-2 text-xs",
        tone === "error"
          ? "border-destructive/30 bg-destructive/5 text-destructive"
          : "border-amber-500/30 bg-amber-500/5",
      )}
    >
      {children}
    </p>
  );
}

function Empty({ children }: { readonly children: ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>;
}

function truncate(text: string, length: number): string {
  return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds)) return "";
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

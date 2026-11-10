import { defineMemory } from "eve/memory";
import { redisAgentMemory } from "../lib/redis-agent-memory";

// Single-user showcase: every caller shares one Redis Agent Memory owner.
// The web UI (apps/web) reads the same owner, so keep the default in sync.
const OWNER_ID = process.env.AGENT_MEMORY_OWNER_ID?.trim() || "showcase-user";

export default defineMemory({
  description: "Recall and manage durable context for the user.",
  provider: redisAgentMemory({ topK: 5, ownerId: OWNER_ID }),
  // A fixed scope keeps memory on for anonymous callers. byPrincipal would turn
  // it off, because the web channel accepts unauthenticated requests.
  scope: OWNER_ID,
});

import { createGateway } from "ai";
import { defineAgent } from "eve";

// Always authenticate to AI Gateway with AI_GATEWAY_API_KEY. A configured key
// takes precedence over Vercel OIDC, and throwing when it's missing keeps the
// agent from silently falling back to OIDC or a local gateway login.
if (!process.env.AI_GATEWAY_API_KEY?.trim()) {
  // The gateway wraps the error thrown below in a generic auth error, so say it plainly here.
  console.error("[agent] AI_GATEWAY_API_KEY is not set; model calls will fail (no OIDC fallback).");
}

const gateway = createGateway({
  apiKey: () => {
    const key = process.env.AI_GATEWAY_API_KEY?.trim();
    if (!key) {
      throw new Error(
        "AI_GATEWAY_API_KEY is not set. This agent only uses the AI Gateway API key.",
      );
    }
    return key;
  },
});

export default defineAgent({
  model: gateway("deepseek/deepseek-v4-flash"),
  // A model instance has no catalog lookup, so set the context window eve uses
  // to decide when to compact (AI Gateway catalog: 1M tokens).
  modelContextWindowTokens: 1_000_000,
  reasoning: "low",
});

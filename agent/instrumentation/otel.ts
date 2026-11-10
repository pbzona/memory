import { otel } from "eve/instrumentation/otel";

// Record prompts, responses, reasoning, and tool arguments/results in traces so
// Vercel Agent Runs can show each turn's Input and Output.
//
// The web channel accepts anonymous callers, so its sessions have audience
// "unknown", which the default policy captures as metadata only in preview and
// production. This is a public, single-user demo, so record content for every
// audience. Memory text is already filtered for profanity and slurs, but traces
// capture raw messages: disclose this to visitors and keep secrets out of chats.
export default otel({
  resource: { "deployment.environment": process.env.VERCEL_ENV ?? "development" },
  tracePolicy: () => ({
    emit: true,
    recordInputs: true,
    recordOutputs: true,
  }),
});

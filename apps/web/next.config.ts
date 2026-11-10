import { existsSync } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";
import type { NextConfig } from "next";

// The agent and the web app share one env file at the repository root
// (`.env.local`, written by `eve link` / `vercel env pull`). Next.js only reads
// env files from its own directory, so load the root ones too. On Vercel the
// project's environment variables are injected directly and this is a no-op.
function findRepoRoot(start: string): string | undefined {
  let dir = start;
  while (true) {
    if (existsSync(path.join(dir, "vercel.ts")) && existsSync(path.join(dir, "agent"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const repoRoot = findRepoRoot(process.cwd());
if (repoRoot) loadEnvConfig(repoRoot, process.env.NODE_ENV !== "production");

const nextConfig: NextConfig = {};

export default nextConfig;

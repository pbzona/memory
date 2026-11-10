import { NextResponse, type NextRequest } from "next/server";
import { readMemorySnapshot } from "@/lib/agent-memory";

export const dynamic = "force-dynamic";

// eve session IDs are opaque; accept only a conservative character set.
const SESSION_ID = /^[A-Za-z0-9_-]{1,200}$/;

export async function GET(request: NextRequest) {
  const session = request.nextUrl.searchParams.get("session") ?? undefined;
  if (session !== undefined && !SESSION_ID.test(session)) {
    return NextResponse.json({ error: "Invalid session ID." }, { status: 400 });
  }
  const snapshot = await readMemorySnapshot(session);
  return NextResponse.json(snapshot, { headers: { "Cache-Control": "no-store" } });
}

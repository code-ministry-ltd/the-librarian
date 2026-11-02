import type { NextRequest } from "next/server";
import { proxyAgentRequest } from "@/lib/agent-proxy";

export const dynamic = "force-dynamic";

// Spec 077 §4.4: the journal's recent window, proxied in single-port mode. Agent-token
// protected upstream, like /mcp.
export function GET(request: NextRequest): Promise<Response> {
  return proxyAgentRequest(request, "/journal.md");
}

export function HEAD(): Response {
  return new Response("Method Not Allowed", { status: 405 });
}

export const OPTIONS = HEAD;

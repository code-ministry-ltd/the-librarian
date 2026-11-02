import "server-only";
import type { NextRequest } from "next/server";
import { DASHBOARD_USER_HEADER } from "@/lib/dashboard-assertion";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3838";
const DEFAULT_BODY_LIMIT = 1024 * 1024;
const INGEST_BODY_LIMIT = 2 * 1024 * 1024;
const UPSTREAM_TIMEOUT_MS = 10_000;
const AUTH_PROBE_TTL_MS = 60_000;
const REQUIRE_EXPLICIT_AUTH_HEADER = "x-librarian-require-auth";
const AUTH_PROBE_STATE_KEY = "__librarianAgentAuthProbeV1";

const STRIP_INBOUND = new Set([
  "host",
  "connection",
  "content-length",
  "cookie",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  DASHBOARD_USER_HEADER,
]);
const STRIP_OUTBOUND = new Set(["content-encoding", "transfer-encoding"]);

export type AgentProxyPath =
  "/healthz" | "/primer.md" | "/journal.md" | "/mcp" | "/transcript" | "/ingest";
type AuthProbeStatus = "enabled" | "disabled" | "unavailable";
interface AuthProbeState {
  cached?: { status: AuthProbeStatus; expiresAt: number };
  inFlight?: Promise<AuthProbeStatus>;
}

class BodyTooLargeError extends Error {}

function isProtected(path: AgentProxyPath): boolean {
  return path === "/mcp" || path === "/transcript" || path === "/ingest" || path === "/journal.md";
}

function bodyLimit(path: AgentProxyPath): number {
  return path === "/ingest" ? INGEST_BODY_LIMIT : DEFAULT_BODY_LIMIT;
}

async function readBoundedBody(req: NextRequest, maxBytes: number): Promise<ArrayBuffer> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new BodyTooLargeError();
  if (req.body === null) return new ArrayBuffer(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(new ArrayBuffer(size));
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

function agentBaseUrl(): string {
  return process.env.LIBRARIAN_SERVER_URL ?? DEFAULT_SERVER_URL;
}

function proxyHeaders(req: NextRequest): Headers {
  const headers = new Headers();
  const stripped = new Set(STRIP_INBOUND);
  for (const name of req.headers.get("connection")?.split(",") ?? []) {
    const normalized = name.trim().toLowerCase();
    if (normalized) stripped.add(normalized);
  }
  for (const [key, value] of req.headers.entries()) {
    if (!stripped.has(key.toLowerCase())) headers.set(key, value);
  }
  return headers;
}

function authProbeState(): AuthProbeState {
  const root = globalThis as typeof globalThis & {
    [AUTH_PROBE_STATE_KEY]?: AuthProbeState;
  };
  root[AUTH_PROBE_STATE_KEY] ??= {};
  return root[AUTH_PROBE_STATE_KEY];
}

async function runAuthProbe(): Promise<AuthProbeStatus> {
  try {
    const url = new URL("/healthz?auth_probe=1", agentBaseUrl());
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!response.ok) return "unavailable";
    const body = (await response.json()) as unknown;
    if (typeof body !== "object" || body === null || !("mcp_auth" in body)) return "unavailable";
    const status = body.mcp_auth;
    if (status === "enabled" || status === "disabled") return status;
    return "unavailable";
  } catch {
    return "unavailable";
  }
}

async function probeAgentAuth(): Promise<AuthProbeStatus> {
  const state = authProbeState();
  if (state.cached !== undefined && state.cached.expiresAt > Date.now()) {
    return state.cached.status;
  }
  delete state.cached;
  if (state.inFlight !== undefined) return state.inFlight;

  const probe = runAuthProbe()
    .then((status) => {
      state.cached = { status, expiresAt: Date.now() + AUTH_PROBE_TTL_MS };
      return status;
    })
    .finally(() => {
      delete state.inFlight;
    });
  state.inFlight = probe;
  return probe;
}

function authGuardResponse(status: AuthProbeStatus): Response | null {
  if (status === "enabled") return null;
  if (status === "disabled") {
    return Response.json(
      {
        error:
          "The upstream agent service is not enforcing authentication. Configure " +
          "LIBRARIAN_AGENT_TOKEN or LIBRARIAN_AGENT_TOKENS and unset " +
          "LIBRARIAN_ALLOW_NO_AUTH before enabling single-port mode.",
      },
      { status: 503 },
    );
  }
  return Response.json(
    { error: "The Librarian agent authentication probe is unavailable." },
    { status: 502 },
  );
}

export function clearAgentAuthProbeCacheForTests(): void {
  const root = globalThis as typeof globalThis & {
    [AUTH_PROBE_STATE_KEY]?: AuthProbeState;
  };
  delete root[AUTH_PROBE_STATE_KEY];
}

export async function proxyAgentRequest(req: NextRequest, path: AgentProxyPath): Promise<Response> {
  if (process.env.LIBRARIAN_SINGLE_PORT !== "true") {
    return new Response("Not Found", { status: 404 });
  }

  if (isProtected(path)) {
    const refused = authGuardResponse(await probeAgentAuth());
    if (refused !== null) return refused;
  }

  const upstream = new URL(path, agentBaseUrl());
  upstream.search = req.nextUrl.search;
  const hasBody = req.method !== "GET" && req.method !== "HEAD";

  let body: ArrayBuffer | undefined;
  try {
    body = hasBody ? await readBoundedBody(req, bodyLimit(path)) : undefined;
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      const limitMb = bodyLimit(path) / (1024 * 1024);
      return Response.json(
        { error: `Request body too large: the ${path} proxy cap is ${limitMb} MB` },
        { status: 413 },
      );
    }
    throw error;
  }

  let upstreamResponse: Response;
  try {
    const headers = proxyHeaders(req);
    if (isProtected(path)) headers.set(REQUIRE_EXPLICIT_AUTH_HEADER, "single-port");
    upstreamResponse = await fetch(upstream, {
      method: req.method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch {
    return Response.json({ error: "The Librarian agent service is unavailable." }, { status: 502 });
  }

  const responseHeaders = new Headers(upstreamResponse.headers);
  for (const key of STRIP_OUTBOUND) responseHeaders.delete(key);
  responseHeaders.set("cache-control", "no-store");

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

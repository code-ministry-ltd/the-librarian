// The Librarian usage-stats receiver (spec 085): a Cloudflare Worker with a D1 database.
//
//   POST /v1/ping   store one ping (one row per install per ISO week), nothing about the request
//   GET  /v1/stats  public aggregates for the last 12 weeks
//   cron            delete rows older than 13 months
//
// Deliberately small: no IP, no headers, no logs of request bodies, no third party.

import { MAX_BODY_BYTES, isoWeek, parsePing, toRow } from "./ping.js";

// The slice of Cloudflare's D1 API this Worker uses (kept local: no @cloudflare/workers-types).
interface D1Statement {
  bind(...values: unknown[]): D1Statement;
  run(): Promise<unknown>;
  all<T>(): Promise<{ results: T[] }>;
}
interface D1Database {
  prepare(sql: string): D1Statement;
}
interface Env {
  DB: D1Database;
}

const RETENTION_DAYS = 396; // about 13 months

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

async function handlePing(request: Request, env: Env): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return json({ error: "invalid" }, 400);
  }
  const ping = parsePing(raw);
  if (!ping) return json({ error: "invalid" }, 400);
  const row = toRow(ping, new Date());
  await env.DB.prepare(
    `INSERT INTO pings (install_id, week, version, os, arch, runtime, harnesses, memories, capture, intake, grooming)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (install_id, week) DO UPDATE SET
       version = excluded.version, os = excluded.os, arch = excluded.arch,
       runtime = excluded.runtime, harnesses = excluded.harnesses, memories = excluded.memories,
       capture = excluded.capture, intake = excluded.intake, grooming = excluded.grooming`,
  )
    .bind(
      row.install_id,
      row.week,
      row.version,
      row.os,
      row.arch,
      row.runtime,
      row.harnesses,
      row.memories,
      row.capture,
      row.intake,
      row.grooming,
    )
    .run();
  return new Response(null, { status: 202 });
}

async function handleStats(env: Env): Promise<Response> {
  const since = isoWeek(new Date(Date.now() - 12 * 7 * 86_400_000));
  const q = (sql: string) => env.DB.prepare(sql).bind(since).all<Record<string, unknown>>();
  const [weekly, versions, runtimes, oses, memories] = await Promise.all([
    q("SELECT week, COUNT(*) AS installs FROM pings WHERE week >= ? GROUP BY week ORDER BY week"),
    q(
      "SELECT version, COUNT(DISTINCT install_id) AS installs FROM pings WHERE week >= ? GROUP BY version ORDER BY installs DESC",
    ),
    q(
      "SELECT runtime, COUNT(DISTINCT install_id) AS installs FROM pings WHERE week >= ? GROUP BY runtime",
    ),
    q("SELECT os, COUNT(DISTINCT install_id) AS installs FROM pings WHERE week >= ? GROUP BY os"),
    q(
      "SELECT memories, COUNT(DISTINCT install_id) AS installs FROM pings WHERE week >= ? GROUP BY memories",
    ),
  ]);
  return json({
    since,
    weekly: weekly.results,
    versions: versions.results,
    runtimes: runtimes.results,
    os: oses.results,
    memories: memories.results,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/v1/ping" && request.method === "POST") return handlePing(request, env);
    if (url.pathname === "/v1/stats" && request.method === "GET") return handleStats(env);
    return json({ error: "not_found" }, 404);
  },

  async scheduled(_event: unknown, env: Env): Promise<void> {
    const cutoff = isoWeek(new Date(Date.now() - RETENTION_DAYS * 86_400_000));
    await env.DB.prepare("DELETE FROM pings WHERE week < ?").bind(cutoff).run();
  },
};

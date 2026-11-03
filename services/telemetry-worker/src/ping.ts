// Validation and storage shape for usage-stats pings (spec 085). Pure functions, no Worker
// globals, so the repo's tests can import them directly.
//
// The receiver keeps only what the server documents it sends (packages/mcp-server/src/telemetry.ts)
// and nothing about the request: no IP, no headers, no exact time (just the ISO week). Anything
// that doesn't match exactly is rejected, so the stored data can't grow fields by accident.

export const HARNESSES = ["claude", "codex", "opencode", "hermes", "pi"] as const;
export const MEMORY_BUCKETS = ["<100", "<1k", "<10k", "10k+"] as const;
export const RUNTIMES = ["docker", "node"] as const;
export const MAX_BODY_BYTES = 2048;

export interface Ping {
  schema: 1;
  installId: string;
  version: string;
  os: string;
  arch: string;
  runtime: (typeof RUNTIMES)[number];
  harnesses: (typeof HARNESSES)[number][];
  memories: (typeof MEMORY_BUCKETS)[number];
  features: { capture: boolean; intake: boolean; grooming: boolean };
}

/** One stored row: one per install per ISO week. */
export interface PingRow {
  install_id: string;
  week: string;
  version: string;
  os: string;
  arch: string;
  runtime: string;
  harnesses: string;
  memories: string;
  capture: number;
  intake: number;
  grooming: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^\d{1,4}\.\d{1,5}\.\d{1,6}$/;
const TOKEN = /^[a-z0-9_]{1,16}$/;
const KEYS = [
  "arch",
  "features",
  "harnesses",
  "installId",
  "memories",
  "os",
  "runtime",
  "schema",
  "version",
];
const FEATURE_KEYS = ["capture", "grooming", "intake"];

function exactKeys(value: object, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((k, i) => k === keys[i]);
}

/** The ping, if `raw` is exactly a valid one; otherwise null. */
export function parsePing(raw: unknown): Ping | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (!exactKeys(p, KEYS)) return null;
  if (p.schema !== 1) return null;
  if (typeof p.installId !== "string" || !UUID.test(p.installId)) return null;
  if (typeof p.version !== "string" || !VERSION.test(p.version)) return null;
  if (typeof p.os !== "string" || !TOKEN.test(p.os)) return null;
  if (typeof p.arch !== "string" || !TOKEN.test(p.arch)) return null;
  if (!RUNTIMES.includes(p.runtime as Ping["runtime"])) return null;
  if (!MEMORY_BUCKETS.includes(p.memories as Ping["memories"])) return null;
  if (!Array.isArray(p.harnesses) || p.harnesses.length > HARNESSES.length) return null;
  if (!p.harnesses.every((h) => HARNESSES.includes(h as Ping["harnesses"][number]))) return null;
  if (new Set(p.harnesses).size !== p.harnesses.length) return null;
  const f = p.features as Record<string, unknown> | null;
  if (!f || typeof f !== "object" || Array.isArray(f) || !exactKeys(f, FEATURE_KEYS)) return null;
  if (!FEATURE_KEYS.every((k) => typeof f[k] === "boolean")) return null;
  return raw as Ping;
}

/** ISO 8601 week, e.g. "2026-W45", in UTC. */
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function toRow(ping: Ping, received: Date): PingRow {
  return {
    install_id: ping.installId,
    week: isoWeek(received),
    version: ping.version,
    os: ping.os,
    arch: ping.arch,
    runtime: ping.runtime,
    harnesses: [...ping.harnesses].sort().join(","),
    memories: ping.memories,
    capture: ping.features.capture ? 1 : 0,
    intake: ping.features.intake ? 1 : 0,
    grooming: ping.features.grooming ? 1 : 0,
  };
}

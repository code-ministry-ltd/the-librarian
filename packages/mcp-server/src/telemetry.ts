// Anonymous usage stats (spec 085): a small weekly ping so the project knows roughly how many
// installs exist and what they run. On by default, with an opt-out, and only after the operator
// has been told:
//
//   - nothing is sent until the install is 24 hours old AND 24 hours have passed since the
//     disclosure notice first reached the dashboard (the notices bell, spec 084);
//   - DO_NOT_TRACK=1 or LIBRARIAN_TELEMETRY=off force it off for the whole server, so a managed
//     deployment never sends a first ping;
//   - Settings → Telemetry has the switch, the exact last payload sent and when, and when the
//     next one is due.
//
// The payload holds no content, titles, names, paths, hostnames, exact counts or IPs: a random
// install id (not derived from the machine, resettable), the version, OS and architecture, how
// it runs, which known harness families have written memories (names only), a size bucket and
// three feature switches. It is built by `buildPayload`, and that is the only thing sent.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import {
  type LibrarianStore,
  isCaptureEnabled,
  isIntakeEnabled,
  readGroomingConfig,
} from "@librarian/core";
import { INSTALL_CREATED_AT_KEY } from "./notices.js";
import { PACKAGE_VERSION } from "./version.js";

export const TELEMETRY_ENABLED_KEY = "telemetry.enabled";
export const TELEMETRY_INSTALL_ID_KEY = "telemetry.installId";
export const TELEMETRY_DISCLOSED_AT_KEY = "telemetry.disclosedAt";
export const TELEMETRY_LAST_SENT_AT_KEY = "telemetry.lastSentAt";
export const TELEMETRY_LAST_PAYLOAD_KEY = "telemetry.lastPayload";

/** Where pings go: the project's own receiver (services/telemetry-worker), no third party. */
export const DEFAULT_TELEMETRY_URL = "https://librarian-telemetry.codeministry.net/v1/ping";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const REQUEST_TIMEOUT_MS = 5_000;

const HARNESS_FAMILIES = ["claude", "codex", "opencode", "hermes", "pi"] as const;
export type HarnessFamily = (typeof HARNESS_FAMILIES)[number];

export interface TelemetryPayload {
  schema: 1;
  installId: string;
  version: string;
  os: string;
  arch: string;
  runtime: "docker" | "node";
  harnesses: HarnessFamily[];
  memories: "<100" | "<1k" | "<10k" | "10k+";
  features: { capture: boolean; intake: boolean; grooming: boolean };
}

type Store = Pick<
  LibrarianStore,
  "getSetting" | "setSetting" | "deleteSetting" | "listSettings" | "getAggregates"
>;
type SettingsOnly = Pick<LibrarianStore, "getSetting">;

/** Why the server would not send right now, or null when it is allowed to. */
export type Blocker =
  | { kind: "forced_off"; by: "DO_NOT_TRACK" | "LIBRARIAN_TELEMETRY" }
  | { kind: "switched_off" }
  | { kind: "not_disclosed" }
  | { kind: "waiting"; until: string };

export function forcedOff(env: NodeJS.ProcessEnv = process.env): Blocker | null {
  const dnt = env.DO_NOT_TRACK?.trim().toLowerCase();
  if (dnt && dnt !== "0" && dnt !== "false") return { kind: "forced_off", by: "DO_NOT_TRACK" };
  const own = env.LIBRARIAN_TELEMETRY?.trim().toLowerCase();
  if (own && ["off", "0", "false", "no"].includes(own)) {
    return { kind: "forced_off", by: "LIBRARIAN_TELEMETRY" };
  }
  return null;
}

function setting(store: SettingsOnly, key: string): string | null {
  try {
    return store.getSetting(key);
  } catch {
    return null;
  }
}

export function telemetryEnabled(store: SettingsOnly): boolean {
  return setting(store, TELEMETRY_ENABLED_KEY) !== "false";
}

function time(store: SettingsOnly, key: string): number | null {
  const raw = setting(store, key);
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : t;
}

/** When the next ping is due (ms), ignoring the switches. Null until disclosed. */
export function nextDueAt(store: SettingsOnly): number | null {
  const disclosed = time(store, TELEMETRY_DISCLOSED_AT_KEY);
  if (disclosed === null) return null;
  const installed = time(store, INSTALL_CREATED_AT_KEY) ?? disclosed;
  const earliest = Math.max(installed + DAY_MS, disclosed + DAY_MS);
  const last = time(store, TELEMETRY_LAST_SENT_AT_KEY);
  return last === null ? earliest : Math.max(earliest, last + WEEK_MS);
}

export function blocker(
  store: SettingsOnly,
  now: number,
  env: NodeJS.ProcessEnv = process.env,
): Blocker | null {
  const forced = forcedOff(env);
  if (forced) return forced;
  if (!telemetryEnabled(store)) return { kind: "switched_off" };
  const due = nextDueAt(store);
  if (due === null) return { kind: "not_disclosed" };
  if (now < due) return { kind: "waiting", until: new Date(due).toISOString() };
  return null;
}

/**
 * Record that the dashboard has shown the disclosure notice. Called when the notices list is
 * served to an admin; only the first call counts.
 */
export function markDisclosed(
  store: Pick<LibrarianStore, "getSetting" | "setSetting">,
  now: Date = new Date(),
): void {
  try {
    if (!store.getSetting(TELEMETRY_DISCLOSED_AT_KEY)) {
      store.setSetting(TELEMETRY_DISCLOSED_AT_KEY, now.toISOString());
    }
  } catch {
    // fail-soft
  }
}

function installId(store: Pick<LibrarianStore, "getSetting" | "setSetting">): string {
  const existing = setting(store, TELEMETRY_INSTALL_ID_KEY);
  if (existing) return existing;
  const id = randomUUID();
  store.setSetting(TELEMETRY_INSTALL_ID_KEY, id);
  return id;
}

/** A new random install id; the next ping counts as a new install. */
export function resetInstallId(store: Pick<LibrarianStore, "setSetting">): string {
  const id = randomUUID();
  store.setSetting(TELEMETRY_INSTALL_ID_KEY, id);
  return id;
}

function bucket(count: number): TelemetryPayload["memories"] {
  if (count < 100) return "<100";
  if (count < 1000) return "<1k";
  if (count < 10000) return "<10k";
  return "10k+";
}

/**
 * Harness families that have written memories, from the memories' agent names. Only the five
 * known families are reported; any other name (which an operator may have chosen themselves) is
 * dropped, never sent.
 */
export function harnessFamilies(agentNames: readonly unknown[]): HarnessFamily[] {
  const found = new Set<HarnessFamily>();
  for (const raw of agentNames) {
    if (typeof raw !== "string") continue;
    const name = raw.toLowerCase();
    for (const family of HARNESS_FAMILIES) {
      const pattern = family === "pi" ? /(^|[^a-z])pi([^a-z]|$)/ : new RegExp(family);
      if (pattern.test(name)) found.add(family);
    }
  }
  return HARNESS_FAMILIES.filter((f) => found.has(f));
}

function runtime(): TelemetryPayload["runtime"] {
  try {
    return fs.existsSync("/.dockerenv") ? "docker" : "node";
  } catch {
    return "node";
  }
}

function safe(read: () => boolean): boolean {
  try {
    return read();
  } catch {
    return false;
  }
}

/** The exact payload a ping would send now. Creates the install id on first use. */
export function buildPayload(store: Store): TelemetryPayload {
  let total = 0;
  let agents: unknown[] = [];
  try {
    const aggregates = store.getAggregates();
    total = aggregates.total;
    agents = aggregates.agents.map((a) => a.value);
  } catch {
    // fail-soft: report the smallest bucket
  }
  return {
    schema: 1,
    installId: installId(store),
    version: PACKAGE_VERSION,
    os: process.platform,
    arch: process.arch,
    runtime: runtime(),
    harnesses: harnessFamilies(agents),
    memories: bucket(total),
    features: {
      capture: safe(() => isCaptureEnabled(store)),
      intake: safe(() => isIntakeEnabled(store)),
      grooming: safe(() => readGroomingConfig(store).enabled),
    },
  };
}

export function telemetryUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIBRARIAN_TELEMETRY_URL || DEFAULT_TELEMETRY_URL;
}

export type SendResult = { sent: true; at: string } | { sent: false; reason: string };

/**
 * Send a ping if one is due. Never throws. On success the payload and time are recorded, so
 * Settings → Telemetry can show exactly what went. A failure is retried on the next tick.
 */
export async function sendIfDue(
  store: Store,
  options: { now?: Date; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<SendResult> {
  const now = options.now ?? new Date();
  const env = options.env ?? process.env;
  const blocked = blocker(store, now.getTime(), env);
  if (blocked) return { sent: false, reason: blocked.kind };
  const payload = buildPayload(store);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetchImpl ?? fetch)(telemetryUrl(env), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "the-librarian" },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: "error",
    });
    if (!response.ok) return { sent: false, reason: `http_${response.status}` };
    const at = now.toISOString();
    store.setSetting(TELEMETRY_LAST_SENT_AT_KEY, at);
    store.setSetting(TELEMETRY_LAST_PAYLOAD_KEY, JSON.stringify(payload));
    return { sent: true, at };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError" ? "timeout" : "network_error";
    return { sent: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

/** What Settings → Telemetry shows. */
export interface TelemetryStatus {
  enabled: boolean;
  forcedOff: "DO_NOT_TRACK" | "LIBRARIAN_TELEMETRY" | null;
  blocker: Blocker | null;
  nextDueAt: string | null;
  lastSentAt: string | null;
  lastPayload: TelemetryPayload | null;
  /** What the next ping would send, so the page can show it before anything has gone. */
  preview: TelemetryPayload;
  url: string;
  intervalDays: 7;
}

export function telemetryStatus(store: Store, now: Date = new Date()): TelemetryStatus {
  const forced = forcedOff();
  const due = nextDueAt(store);
  let lastPayload: TelemetryPayload | null = null;
  try {
    const raw = store.getSetting(TELEMETRY_LAST_PAYLOAD_KEY);
    lastPayload = raw ? (JSON.parse(raw) as TelemetryPayload) : null;
  } catch {
    lastPayload = null;
  }
  return {
    enabled: telemetryEnabled(store),
    forcedOff: forced?.kind === "forced_off" ? forced.by : null,
    blocker: blocker(store, now.getTime()),
    nextDueAt: due === null ? null : new Date(due).toISOString(),
    lastSentAt: setting(store, TELEMETRY_LAST_SENT_AT_KEY),
    lastPayload,
    preview: buildPayload(store),
    url: telemetryUrl(),
    intervalDays: 7,
  };
}

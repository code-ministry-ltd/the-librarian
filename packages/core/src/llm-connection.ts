// Shared LLM-connection helper — the per-LLM connection block a consumer
// needs: provider/endpoint/model/timeoutMs + an encrypted bearer token. A
// consumer passes its own keyspace prefix (e.g. `curator.llm`) and the helper
// composes the five settings keys under it. The named-provider store
// (`llm-providers.ts`) reuses the same secret-token-as-separate-key pattern.
//
// Reads NEVER include the token plaintext — only `hasToken`. The
// settings-store metadata carries presence, so the cockpit can render
// without the master key. Only `resolveLlmToken` decrypts.

import { z } from "zod";
import type { SettingMeta } from "./store/settings-store.js";

// 5 min default (was 60 s) — slow self-hosted models run 1–4 min per call.
const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

export interface LlmConnection {
  provider: string;
  endpoint: string;
  model: string;
  /** Per-request timeout in ms. Default 5 min; range [1s, 10min]. */
  timeoutMs: number;
}

export interface LlmConnectionPatch {
  provider?: string;
  endpoint?: string;
  model?: string;
  timeoutMs?: number;
}

// Zod input shape for admin patch validation at the tRPC boundary.
// Permissive: deeper invariants (timeoutMs bounds) are enforced in
// `writeLlmConnection`, which is the single source of truth.
export const LlmConnectionPatchSchema = z.strictObject({
  provider: z.string().optional(),
  endpoint: z.string().optional(),
  model: z.string().optional(),
  timeoutMs: z.number().optional(),
});

export interface LlmConnectionKeys {
  provider: string;
  endpoint: string;
  model: string;
  timeoutMs: string;
  token: string;
}

/**
 * Derive the five settings keys for a given prefix. The prefix
 * conventionally ends in `.llm` (e.g. `curator.llm`) but the helper does
 * not enforce that — any unique prefix works.
 */
export function llmConnectionKeys(prefix: string): LlmConnectionKeys {
  return {
    provider: `${prefix}.provider`,
    endpoint: `${prefix}.endpoint`,
    model: `${prefix}.model`,
    timeoutMs: `${prefix}.timeout_ms`,
    token: `${prefix}.token`,
  };
}

// The slice of the store this module needs for reads.
export interface LlmConnectionReader {
  getSetting: (key: string) => string | null;
  listSettings: () => SettingMeta[];
}

// The slice of the store this module needs for writes.
export interface LlmConnectionWriter {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  deleteSetting: (key: string) => void;
}

/**
 * Read the LLM-connection block under `keys`. Returns the four config
 * fields plus `hasToken` (presence-only, no decryption) and
 * `isComplete` (provider + endpoint + model + token all present).
 */
export function readLlmConnection(
  store: LlmConnectionReader,
  keys: LlmConnectionKeys,
): LlmConnection & { hasToken: boolean; isComplete: boolean } {
  const provider = store.getSetting(keys.provider) ?? "";
  const endpoint = store.getSetting(keys.endpoint) ?? "";
  const model = store.getSetting(keys.model) ?? "";
  const timeoutMs = parseTimeoutMs(store.getSetting(keys.timeoutMs));
  const hasToken = store.listSettings().some((s) => s.key === keys.token);
  return {
    provider,
    endpoint,
    model,
    timeoutMs,
    hasToken,
    isComplete: Boolean(provider && endpoint && model && hasToken),
  };
}

/**
 * Write a patch. Validates bounds before touching the store (a bad
 * patch makes no change). Token is stored encrypted; an empty-string
 * token is treated as a clear, not a write.
 */
export function writeLlmConnection(
  store: LlmConnectionWriter,
  keys: LlmConnectionKeys,
  patch: LlmConnectionPatch & { token?: string },
): void {
  if (patch.timeoutMs !== undefined) {
    const t = patch.timeoutMs;
    if (!Number.isInteger(t) || t < MIN_TIMEOUT_MS || t > MAX_TIMEOUT_MS) {
      throw new Error(
        `llm timeout_ms must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} (1s and 10min)`,
      );
    }
  }

  if (patch.provider !== undefined) store.setSetting(keys.provider, patch.provider);
  if (patch.endpoint !== undefined) store.setSetting(keys.endpoint, patch.endpoint);
  if (patch.model !== undefined) store.setSetting(keys.model, patch.model);
  if (patch.timeoutMs !== undefined) store.setSetting(keys.timeoutMs, String(patch.timeoutMs));
  if (patch.token !== undefined) {
    if (patch.token === "") store.deleteSetting(keys.token);
    else store.setSetting(keys.token, patch.token, { secret: true });
  }
}

/** Decrypt the stored LLM token. Returns null when unset. Needs the master key. */
export function resolveLlmToken(
  store: { getSetting: (key: string) => string | null },
  keys: LlmConnectionKeys,
): string | null {
  return store.getSetting(keys.token);
}

function parseTimeoutMs(raw: string | null): number {
  if (raw === null) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) ? n : DEFAULT_TIMEOUT_MS;
}

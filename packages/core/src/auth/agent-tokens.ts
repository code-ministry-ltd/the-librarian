// DB-stored agent tokens (spec: single-owner-auth, A3).
//
// The owner mints agent tokens from the dashboard instead of hand-editing the
// LIBRARIAN_AGENT_TOKENS env var. Tokens are high-entropy random values, so we
// store a salted SHA-256 HASH (not reversible encryption) — even a settings dump
// can't recover a token. The plaintext is returned exactly ONCE, at creation.
//
// Token shape: `lib.<id>.<secret>` (the id locates the record in O(1); base64url
// never contains `.`, so the split is unambiguous). Verification recomputes the
// hash for that id and compares timing-safe. Stored in the existing `settings`
// table (key `agent_token:<id>`, plain — the value is already a hash), so there is
// NO schema bump and verification works without LIBRARIAN_SECRET_KEY.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isReservedId } from "../caller-identity.js";

const KEY_PREFIX = "agent_token:";
const TOKEN_PREFIX = "lib";
const MAX_AGENT_ID = 128;

/**
 * A token's privilege scope (ingest spec D21). `agent` reaches the 8-verb /mcp
 * surface; `capture` is least-privilege — it reaches ONLY the /ingest endpoint
 * (browser extension / mobile share) and is actively walled off from /mcp. The
 * scope is a FIRST-CLASS stored field, not inferred: the auth layer enforces it
 * bidirectionally, so a capture token pasted into a browser extension can never
 * be replayed against the memory surface.
 */
export type TokenScope = "agent" | "capture";

const TOKEN_SCOPES: readonly TokenScope[] = ["agent", "capture"];

/** A record with no stored scope predates the field → treat as `agent`, never capture. */
function recordScope(record: { scope?: string }): TokenScope {
  return record.scope === "capture" ? "capture" : "agent";
}

type SettingsLike = {
  setSetting: (key: string, value: string, options?: { secret?: boolean }) => void;
  getSetting: (key: string) => string | null;
  deleteSetting?: (key: string) => void;
  listSettings: () => { key: string }[];
};

interface TokenRecord {
  id: string;
  agentId: string;
  label: string;
  scope?: TokenScope;
  salt: string;
  hash: string;
  created_at: string;
}

export interface AgentTokenMeta {
  id: string;
  agentId: string;
  label: string;
  scope: TokenScope;
  created_at: string;
}

export interface CreatedAgentToken {
  id: string;
  token: string;
}

function hashSecret(salt: string, secret: string): string {
  return createHash("sha256").update(`${salt}:${secret}`).digest("hex");
}

export function createAgentToken(
  store: SettingsLike,
  input: { agentId: string; label?: string; scope?: TokenScope },
): CreatedAgentToken {
  // agentId becomes a live authorization principal (the returned identity), so
  // validate it at mint: non-empty, bounded, and never a reserved system/dashboard
  // /cli id that a minted token could otherwise impersonate.
  const agentId = (input.agentId ?? "").trim();
  if (!agentId) throw new Error("agentId is required");
  if (agentId.length > MAX_AGENT_ID) throw new Error(`agentId is too long (max ${MAX_AGENT_ID})`);
  if (isReservedId(agentId)) throw new Error(`agentId is reserved: ${agentId}`);

  // Default to the legacy `agent` scope so existing callers mint unchanged; reject
  // anything outside the known set rather than silently storing an invalid scope a
  // later enforcement check would have to second-guess.
  const scope = input.scope ?? "agent";
  if (!TOKEN_SCOPES.includes(scope)) {
    throw new Error(`Unknown token scope: ${scope}. Expected one of: ${TOKEN_SCOPES.join(", ")}`);
  }

  const id = randomBytes(9).toString("base64url");
  const secret = randomBytes(24).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  const record: TokenRecord = {
    id,
    agentId,
    label: input.label ?? "",
    scope,
    salt,
    hash: hashSecret(salt, secret),
    created_at: new Date().toISOString(),
  };
  store.setSetting(KEY_PREFIX + id, JSON.stringify(record));
  return { id, token: `${TOKEN_PREFIX}.${id}.${secret}` };
}

export function listAgentTokens(store: SettingsLike): AgentTokenMeta[] {
  const metas: AgentTokenMeta[] = [];
  for (const { key } of store.listSettings()) {
    if (!key.startsWith(KEY_PREFIX)) continue;
    const raw = store.getSetting(key);
    if (!raw) continue;
    try {
      const r = JSON.parse(raw) as TokenRecord;
      metas.push({
        id: r.id,
        agentId: r.agentId,
        label: r.label,
        scope: recordScope(r),
        created_at: r.created_at,
      });
    } catch {
      // skip a malformed record rather than failing the whole list
    }
  }
  return metas.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function revokeAgentToken(store: SettingsLike, id: string): boolean {
  if (!store.getSetting(KEY_PREFIX + id)) return false;
  store.deleteSetting?.(KEY_PREFIX + id);
  return true;
}

export function verifyAgentToken(
  store: SettingsLike,
  presented: string,
): { agentId: string; scope: TokenScope; tokenId: string } | null {
  const parts = presented.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, id, secret] = parts;
  const raw = store.getSetting(KEY_PREFIX + id);
  // Early return on an unknown id is intentional and safe: the id is public (it
  // travels in the token), and the secret is gated by the constant-time compare
  // below — the only thing this "leaks" is id existence, which the holder knows.
  if (!raw) return null;
  let record: TokenRecord;
  try {
    record = JSON.parse(raw) as TokenRecord;
  } catch {
    return null;
  }
  const candidate = Buffer.from(hashSecret(record.salt, secret ?? ""), "hex");
  const stored = Buffer.from(record.hash, "hex");
  if (candidate.length !== stored.length || !timingSafeEqual(candidate, stored)) return null;
  // The token RECORD id (the `<id>` in `lib.<id>.<secret>`) is a stable per-token
  // identity surfaced for the /ingest rate limiter (ingest spec D19): the limiter
  // keys on the specific token so a leaked token's quota is bounded on its own.
  // `record.agentId` is returned WITHOUT re-validation: a well-formed record always
  // carries one (createAgentToken enforces a non-empty, non-reserved agentId at mint),
  // but this is NOT produced by well-formed records — a hand-edited / malformed record
  // may omit it, and such a record lands here (and downstream in the auth provider's
  // `env-token-agent` sentinel bucket, no boundActorId). Rejecting a malformed record
  // here would be an out-of-scope behaviour change (spec 061 review fix 8).
  return { agentId: record.agentId, scope: recordScope(record), tokenId: record.id };
}

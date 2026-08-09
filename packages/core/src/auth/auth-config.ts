// Dashboard auth configuration (dashboard-managed-auth, D1.4).
//
// The owner's auth setup — enabled flag, OAuth client creds, OAuth owner allowlist —
// lives in the settings table so it can change without a redeploy. OAuth client
// secrets are stored {secret:true} (encrypted at rest, reversible — the dashboard
// needs them to build providers). The password lives separately as a one-way hash
// (password.ts); this config exposes only the username, never the hash.
//
// AUTH_SECRET (the JWT signing key) is HKDF-derived from LIBRARIAN_SECRET_KEY rather
// than stored: nothing extra to persist or rotate, and rotating the master key
// rotates sessions.

import { createHash, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  type SettingsLike,
  hasOwnerPassword,
  ownerPasswordUsername,
  readJsonSetting,
} from "./password.js";

export type OAuthProvider = "github" | "google";
export type AuthMethod = "password" | OAuthProvider;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface AuthConfig {
  enabled: boolean;
  /** Which login methods are fully configured. */
  methods: AuthMethod[];
  /** The password method's username (never the hash), or null when unset. */
  password: { username: string } | null;
  /** Decrypted OAuth client creds, per configured provider. */
  oauth: { github?: OAuthClient; google?: OAuthClient };
  /** Allowlisted owner account id per provider (for the signIn callback). */
  ownerOAuth: { github?: string; google?: string };
  /** HKDF-derived JWT secret; null when no master key is available. */
  authSecret: string | null;
}

const ENABLED_KEY = "auth:enabled";
const OAUTH_PREFIX = "auth:oauth:"; // secret JSON {clientId, clientSecret}
const OWNER_PREFIX = "auth:owner:"; // plain owner account id
const AUTH_SECRET_INFO = "dashboard-jwt-v1";
const AUTH_SECRET_BYTES = 32;
const OAUTH_PROVIDERS: OAuthProvider[] = ["github", "google"];

// Low-level enabled-flag setter. Turning auth ON should go through enableAuth (the
// admin-token + completeness gate) — calling setEnabled(store, true) directly skips
// that gate. The disable direction is ungated by design (break-glass).
export function setEnabled(store: SettingsLike, enabled: boolean): void {
  store.setSetting(ENABLED_KEY, enabled ? "true" : "false");
}

/** Whether dashboard enforcement has been explicitly enabled in the store. */
export function isAuthEnabled(store: SettingsLike): boolean {
  return store.getSetting(ENABLED_KEY) === "true";
}

/**
 * Bootstrap ownership deliberately keys only on enforcement, not configured
 * methods. A password written before a crash remains safely overwriteable while
 * the instance is still disabled.
 */
export function isAuthUnowned(store: SettingsLike): boolean {
  return !isAuthEnabled(store);
}

export function setOAuth(store: SettingsLike, provider: OAuthProvider, client: OAuthClient): void {
  const clientId = client.clientId.trim();
  const clientSecret = client.clientSecret;
  if (!clientId || !clientSecret) throw new Error("clientId and clientSecret are required");
  store.setSetting(OAUTH_PREFIX + provider, JSON.stringify({ clientId, clientSecret }), {
    secret: true,
  });
}

export function setOwner(store: SettingsLike, provider: OAuthProvider, ownerId: string): void {
  const id = ownerId.trim();
  if (!id) throw new Error("owner id is required");
  store.setSetting(OWNER_PREFIX + provider, id);
}

/** Derive the dashboard JWT secret from the master key (stable per key). */
export function deriveAuthSecret(secretKey: Buffer | null): string | null {
  if (!secretKey) return null;
  const out = hkdfSync("sha256", secretKey, Buffer.alloc(0), AUTH_SECRET_INFO, AUTH_SECRET_BYTES);
  return Buffer.from(out).toString("hex");
}

function readOAuth(store: SettingsLike, provider: OAuthProvider): OAuthClient | undefined {
  // readJsonSetting swallows a missing key / undecryptable / malformed value (→ null),
  // so an un-decryptable provider reads as "not configured" rather than throwing.
  const parsed = readJsonSetting<Partial<OAuthClient>>(store, OAUTH_PREFIX + provider);
  if (!parsed?.clientId || !parsed.clientSecret) return undefined;
  return { clientId: parsed.clientId, clientSecret: parsed.clientSecret };
}

export function getAuthConfig(store: SettingsLike, secretKey: Buffer | null): AuthConfig {
  const oauth: AuthConfig["oauth"] = {};
  const ownerOAuth: AuthConfig["ownerOAuth"] = {};
  for (const provider of OAUTH_PROVIDERS) {
    const client = readOAuth(store, provider);
    if (client) oauth[provider] = client;
    const owner = store.getSetting(OWNER_PREFIX + provider);
    if (owner) ownerOAuth[provider] = owner;
  }

  const username = ownerPasswordUsername(store);
  const methods: AuthMethod[] = [];
  if (hasOwnerPassword(store)) methods.push("password");
  if (oauth.github) methods.push("github");
  if (oauth.google) methods.push("google");

  return {
    enabled: isAuthEnabled(store),
    methods,
    password: username ? { username } : null,
    oauth,
    ownerOAuth,
    authSecret: deriveAuthSecret(secretKey),
  };
}

export interface AuthStatus {
  enabled: boolean;
  methods: AuthMethod[];
  /** The password method's username, or null. Never the hash. */
  passwordUsername: string | null;
  ownerOAuth: { github?: string; google?: string };
}

/**
 * A key-independent view of the auth config: which methods are configured, the
 * enabled flag, the password username, and the OAuth owner allowlist — derived from
 * setting *presence* (listSettings metadata) rather than decrypting anything. Lets
 * the CLI report status with no master key, and never surfaces a secret.
 */
export function getAuthStatus(store: SettingsLike): AuthStatus {
  const keys = new Set(store.listSettings().map((s) => s.key));
  const methods: AuthMethod[] = [];
  if (hasOwnerPassword(store)) methods.push("password");
  if (keys.has(`${OAUTH_PREFIX}github`)) methods.push("github");
  if (keys.has(`${OAUTH_PREFIX}google`)) methods.push("google");
  const ownerOAuth: AuthStatus["ownerOAuth"] = {};
  const github = store.getSetting(`${OWNER_PREFIX}github`);
  const google = store.getSetting(`${OWNER_PREFIX}google`);
  if (github) ownerOAuth.github = github;
  if (google) ownerOAuth.google = google;
  return {
    enabled: isAuthEnabled(store),
    methods,
    passwordUsername: ownerPasswordUsername(store),
    ownerOAuth,
  };
}

/**
 * Is this config safe to enforce? Requires a derivable JWT secret AND at least one
 * *usable* login method — password, or an OAuth provider with both creds and an
 * owner allowlist. OAuth creds without an owner would deny everyone (the allowlist
 * is deny-by-default), so that doesn't count: enabling it would lock the owner out.
 */
export function isAuthConfigComplete(config: AuthConfig): boolean {
  if (!config.authSecret) return false;
  if (config.methods.includes("password")) return true;
  if (config.oauth.github && config.ownerOAuth.github) return true;
  if (config.oauth.google && config.ownerOAuth.google) return true;
  return false;
}

function tokensMatch(presented: string, expected: string): boolean {
  if (!presented || !expected) return false;
  // Hash to a fixed length so the compare is constant-time regardless of input length.
  const a = createHash("sha256").update(presented).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export interface EnableAuthInput {
  presentedAdminToken: string;
  expectedAdminToken: string;
  secretKey: Buffer | null;
}

export type EnableAuthResult =
  { ok: true } | { ok: false; error: "bad_admin_token" | "incomplete" };

/**
 * Flip enforcement on — the one mutation that must be admin-gated even before
 * enforcement exists (the proxy is open in the un-enforced window, so any visitor
 * could otherwise drive it). Requires a timing-safe match against the configured
 * admin token AND a complete, usable config, validated BEFORE the flag is persisted
 * so a rejected attempt never leaves auth half-on.
 */
export function enableAuth(store: SettingsLike, input: EnableAuthInput): EnableAuthResult {
  if (!tokensMatch(input.presentedAdminToken, input.expectedAdminToken)) {
    return { ok: false, error: "bad_admin_token" };
  }
  if (!isAuthConfigComplete(getAuthConfig(store, input.secretKey))) {
    return { ok: false, error: "incomplete" };
  }
  setEnabled(store, true);
  return { ok: true };
}

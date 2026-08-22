// Per-consumer LLM resolution (spec 042 §2). Each curator consumer — `intake`
// (the intake) and `grooming` (the curator) — references a named provider
// by id and adds its own `{ model, timeout_ms }`. `readConsumerConfig` joins the
// consumer's settings with the provider; `resolveConsumerToken` decrypts the
// provider's key; `migrateLegacyCuratorLlm` synthesises a `default` provider from
// a pre-existing `curator.llm.*` install. Mirrors the provider-store harness.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CURATOR_CONSUMERS,
  type LibrarianStore,
  addProvider,
  createLibrarianStore,
  deleteProvider,
  listProviders,
  llmConnectionKeys,
  migrateLegacyCuratorLlm,
  readConsumerConfig,
  resolveConsumerToken,
  resolveSecretKey,
  writeConsumerConfig,
  writeLlmConnection,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Assemble the 64-hex key at runtime — no secret-shaped literal in source (GitGuardian).
const KEY = resolveSecretKey("0123456789abcdef".repeat(4));

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-consumers-"));
  const store = createLibrarianStore({ dataDir, secretKey: KEY });
  return { store, dataDir };
}

function teardown(s: Scope | null): void {
  if (!s) return;
  try {
    s.store.close();
  } catch {
    /* ignore */
  }
  fs.rmSync(s.dataDir, { recursive: true, force: true });
}

describe("per-consumer LLM resolution", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  describe("readConsumerConfig defaults", () => {
    it("returns inert defaults when nothing is configured", () => {
      const { store } = s!;
      for (const c of ["intake", "grooming"] as const) {
        const cfg = readConsumerConfig(store, c);
        expect(cfg).toMatchObject({
          consumer: c,
          providerId: "",
          providerExists: false,
          endpoint: "",
          model: "",
          timeoutMs: 300_000,
          hasToken: false,
          isOperational: false,
        });
      }
    });

    it("clamps an out-of-range stored timeout back to the default on read", () => {
      const { store } = s!;
      // A hand-edited vault value must never reach a tick as 0/negative/huge.
      store.setSetting("curator.intake.timeout_ms", "0");
      expect(readConsumerConfig(store, "intake").timeoutMs).toBe(300_000);
      store.setSetting("curator.intake.timeout_ms", "999999999");
      expect(readConsumerConfig(store, "intake").timeoutMs).toBe(300_000);
      store.setSetting("curator.intake.timeout_ms", "not-a-number");
      expect(readConsumerConfig(store, "intake").timeoutMs).toBe(300_000);
    });

    it("round-trips the unified per-consumer enabled flag (spec 043 D-E)", () => {
      const { store } = s!;
      // Default off until explicitly enabled.
      expect(readConsumerConfig(store, "intake").enabled).toBe(false);
      expect(readConsumerConfig(store, "grooming").enabled).toBe(false);

      writeConsumerConfig(store, "intake", { enabled: true });
      expect(readConsumerConfig(store, "intake").enabled).toBe(true);
      // The consumer surface and the unified setting key agree.
      expect(store.getSetting("curator.intake.enabled")).toBe("true");
      // Enabling intake does not enable grooming.
      expect(readConsumerConfig(store, "grooming").enabled).toBe(false);

      writeConsumerConfig(store, "intake", { enabled: false });
      expect(readConsumerConfig(store, "intake").enabled).toBe(false);
      expect(store.getSetting("curator.intake.enabled")).toBe("false");
    });
  });

  describe("operational truth table", () => {
    it("is operational only when the provider exists, has a token, and a model is set", () => {
      const { store } = s!;
      const p = addProvider(store, {
        name: "OpenAI",
        endpoint: "https://api.openai.com/v1",
        token: "dummy-openai-token",
      });

      // provider set + model set + token present -> operational, endpoint resolved
      writeConsumerConfig(store, "grooming", { providerId: p.id, model: "gpt-4o" });
      let cfg = readConsumerConfig(store, "grooming");
      expect(cfg.providerExists).toBe(true);
      expect(cfg.endpoint).toBe("https://api.openai.com/v1");
      expect(cfg.hasToken).toBe(true);
      expect(cfg.isOperational).toBe(true);

      // model cleared -> not operational
      writeConsumerConfig(store, "grooming", { model: "" });
      expect(readConsumerConfig(store, "grooming").isOperational).toBe(false);

      // points at a provider with no token -> not operational
      const noTok = addProvider(store, { name: "Local", endpoint: "http://localhost:11434/v1" });
      writeConsumerConfig(store, "intake", { providerId: noTok.id, model: "llama3" });
      cfg = readConsumerConfig(store, "intake");
      expect(cfg.providerExists).toBe(true);
      expect(cfg.hasToken).toBe(false);
      expect(cfg.isOperational).toBe(false);

      // points at a non-existent provider -> not operational, no throw
      writeConsumerConfig(store, "intake", { providerId: "prov_ghost", model: "x" });
      cfg = readConsumerConfig(store, "intake");
      expect(cfg.providerExists).toBe(false);
      expect(cfg.endpoint).toBe("");
      expect(cfg.isOperational).toBe(false);
    });
  });

  describe("independence", () => {
    it("lets intake and grooming use different providers + models", () => {
      const { store } = s!;
      const cheap = addProvider(store, {
        name: "Cheap",
        endpoint: "https://cheap.example/v1",
        token: "dummy-cheap",
      });
      const strong = addProvider(store, {
        name: "Strong",
        endpoint: "https://strong.example/v1",
        token: "dummy-strong",
      });
      writeConsumerConfig(store, "intake", { providerId: cheap.id, model: "mini" });
      writeConsumerConfig(store, "grooming", { providerId: strong.id, model: "max" });

      const intake = readConsumerConfig(store, "intake");
      const grooming = readConsumerConfig(store, "grooming");
      expect(intake.endpoint).toBe("https://cheap.example/v1");
      expect(intake.model).toBe("mini");
      expect(grooming.endpoint).toBe("https://strong.example/v1");
      expect(grooming.model).toBe("max");
      expect(resolveConsumerToken(store, "intake")).toBe("dummy-cheap");
      expect(resolveConsumerToken(store, "grooming")).toBe("dummy-strong");
    });
  });

  describe("resolveConsumerToken", () => {
    it("returns null when unset and after the provider is deleted", () => {
      const { store } = s!;
      expect(resolveConsumerToken(store, "grooming")).toBeNull();
      const p = addProvider(store, {
        name: "P",
        endpoint: "https://p.example/v1",
        token: "dummy-p-token",
      });
      writeConsumerConfig(store, "grooming", { providerId: p.id, model: "m" });
      expect(resolveConsumerToken(store, "grooming")).toBe("dummy-p-token");

      deleteProvider(store, p.id);
      expect(resolveConsumerToken(store, "grooming")).toBeNull();
      const cfg = readConsumerConfig(store, "grooming");
      expect(cfg.providerExists).toBe(false);
      expect(cfg.isOperational).toBe(false);
    });
  });

  describe("writeConsumerConfig validation", () => {
    it("rejects an out-of-bounds timeout", () => {
      const { store } = s!;
      expect(() => writeConsumerConfig(store, "intake", { timeoutMs: 0 })).toThrow(/timeout/i);
      expect(() => writeConsumerConfig(store, "intake", { timeoutMs: 600_001 })).toThrow(
        /timeout/i,
      );
      expect(() => writeConsumerConfig(store, "intake", { timeoutMs: 1.5 })).toThrow(/timeout/i);
    });
  });

  // The `chat` consumer (spec 044 D-8): a third, CONFIG-ONLY LLM consumer for the
  // interactive curator chat endpoint (D6b). It is NOT a job — no enablement key,
  // no scheduler, no legacy migration. When its own config is unset it falls back
  // WHOLE-CONSUMER to the grooming consumer (provider + model + token + timeout).
  describe("chat consumer (config-only, grooming fallback)", () => {
    it("round-trips its own provider/model/timeout", () => {
      const { store } = s!;
      const p = addProvider(store, {
        name: "ChatProvider",
        endpoint: "https://chat.example/v1",
        token: "dummy-chat-token",
      });
      writeConsumerConfig(store, "chat", {
        providerId: p.id,
        model: "chat-model",
        timeoutMs: 30_000,
      });

      const cfg = readConsumerConfig(store, "chat");
      expect(cfg.consumer).toBe("chat");
      expect(cfg.providerId).toBe(p.id);
      expect(cfg.endpoint).toBe("https://chat.example/v1");
      expect(cfg.model).toBe("chat-model");
      expect(cfg.timeoutMs).toBe(30_000);
      expect(cfg.hasToken).toBe(true);
      expect(cfg.isOperational).toBe(true);
      // The writes land under the `curator.chat.*` namespace.
      expect(store.getSetting("curator.chat.provider")).toBe(p.id);
      expect(store.getSetting("curator.chat.model")).toBe("chat-model");
      expect(store.getSetting("curator.chat.timeout_ms")).toBe("30000");
    });

    it("the token is write-only — only presence (hasToken) is read back", () => {
      const { store } = s!;
      const p = addProvider(store, {
        name: "ChatP",
        endpoint: "https://c.example/v1",
        token: "dummy-chat-secret",
      });
      writeConsumerConfig(store, "chat", { providerId: p.id, model: "m" });
      const cfg = readConsumerConfig(store, "chat");
      expect(cfg.hasToken).toBe(true);
      // The resolved view never carries the token value itself.
      expect(JSON.stringify(cfg)).not.toContain("dummy-chat-secret");
    });

    it("falls back WHOLE-CONSUMER to grooming when chat's own config is unset", () => {
      const { store } = s!;
      const groom = addProvider(store, {
        name: "Groom",
        endpoint: "https://groom.example/v1",
        token: "dummy-groom-token",
      });
      writeConsumerConfig(store, "grooming", {
        providerId: groom.id,
        model: "groom-model",
        timeoutMs: 42_000,
      });

      // chat is entirely unset -> resolves from grooming (provider/model/token/timeout).
      const cfg = readConsumerConfig(store, "chat");
      expect(cfg.consumer).toBe("chat");
      expect(cfg.providerId).toBe(groom.id);
      expect(cfg.endpoint).toBe("https://groom.example/v1");
      expect(cfg.model).toBe("groom-model");
      expect(cfg.timeoutMs).toBe(42_000);
      expect(cfg.hasToken).toBe(true);
      expect(cfg.isOperational).toBe(true);
      // The token resolves from grooming's provider too.
      expect(resolveConsumerToken(store, "chat")).toBe("dummy-groom-token");
    });

    it("uses chat's OWN config (not grooming's) once chat's provider is set", () => {
      const { store } = s!;
      const groom = addProvider(store, {
        name: "Groom",
        endpoint: "https://groom.example/v1",
        token: "dummy-groom-token",
      });
      const chat = addProvider(store, {
        name: "Chat",
        endpoint: "https://chat.example/v1",
        token: "dummy-chat-own",
      });
      writeConsumerConfig(store, "grooming", {
        providerId: groom.id,
        model: "groom-model",
        timeoutMs: 42_000,
      });
      writeConsumerConfig(store, "chat", {
        providerId: chat.id,
        model: "chat-model",
        timeoutMs: 30_000,
      });

      const cfg = readConsumerConfig(store, "chat");
      expect(cfg.providerId).toBe(chat.id);
      expect(cfg.endpoint).toBe("https://chat.example/v1");
      expect(cfg.model).toBe("chat-model");
      expect(cfg.timeoutMs).toBe(30_000);
      expect(resolveConsumerToken(store, "chat")).toBe("dummy-chat-own");
    });

    it("falls back for resolveConsumerToken when chat is unset but grooming is set", () => {
      const { store } = s!;
      const groom = addProvider(store, {
        name: "Groom",
        endpoint: "https://groom.example/v1",
        token: "dummy-groom-token",
      });
      writeConsumerConfig(store, "grooming", { providerId: groom.id, model: "m" });
      expect(resolveConsumerToken(store, "chat")).toBe("dummy-groom-token");
    });

    it("resolves inert (not operational) when neither chat nor grooming is configured", () => {
      const { store } = s!;
      const cfg = readConsumerConfig(store, "chat");
      expect(cfg.consumer).toBe("chat");
      expect(cfg.providerId).toBe("");
      expect(cfg.providerExists).toBe(false);
      expect(cfg.isOperational).toBe(false);
      expect(resolveConsumerToken(store, "chat")).toBeNull();
    });

    it("is NOT a job: not in CURATOR_CONSUMERS and has no enablement key", () => {
      const { store } = s!;
      // The job-iteration list must stay intake+grooming only.
      expect(CURATOR_CONSUMERS).toEqual(["intake", "grooming"]);
      expect(CURATOR_CONSUMERS).not.toContain("chat");

      // chat has no enablement key; its resolved config never reports enabled.
      writeConsumerConfig(store, "chat", { providerId: "p", model: "m" });
      expect(readConsumerConfig(store, "chat").enabled).toBe(false);
      // No `curator.chat.enabled` setting is ever written.
      expect(store.getSetting("curator.chat.enabled")).toBeNull();
    });

    it("rejects an attempt to enable/disable chat (it has no enablement)", () => {
      const { store } = s!;
      expect(() => writeConsumerConfig(store, "chat", { enabled: true })).toThrow(/enablement/i);
      expect(() => writeConsumerConfig(store, "chat", { enabled: false })).toThrow(/enablement/i);
      // The rejection fires before any write -> no chat enablement key materialises.
      expect(store.getSetting("curator.chat.enabled")).toBeNull();
    });

    it("migrateLegacyCuratorLlm does NOT seed a chat config (chat is not a job)", () => {
      const { store } = s!;
      writeLlmConnection(store, llmConnectionKeys("curator.llm"), {
        provider: "openai",
        endpoint: "https://legacy.example/v1",
        model: "legacy-model",
        timeoutMs: 45_000,
        token: "dummy-legacy-token",
      });
      expect(migrateLegacyCuratorLlm(store)).toBe(true);
      // Migration seeds intake + grooming only — never chat's own keys.
      expect(store.getSetting("curator.chat.provider")).toBeNull();
      expect(store.getSetting("curator.chat.model")).toBeNull();
      expect(store.getSetting("curator.chat.timeout_ms")).toBeNull();
      // But chat still RESOLVES (via the grooming fallback) to the migrated config.
      const cfg = readConsumerConfig(store, "chat");
      expect(cfg.model).toBe("legacy-model");
      expect(cfg.isOperational).toBe(true);
    });
  });

  describe("Chronicle consumer (grooming fallback)", () => {
    it("inherits the whole grooming connection while keeping Chronicle enablement", () => {
      const { store } = s!;
      const groom = addProvider(store, {
        name: "Groom",
        endpoint: "https://groom.example/v1",
        token: "dummy-groom-token",
      });
      writeConsumerConfig(store, "grooming", {
        providerId: groom.id,
        model: "groom-model",
        timeoutMs: 42_000,
      });
      writeConsumerConfig(store, "chronicle", { enabled: true });

      expect(readConsumerConfig(store, "chronicle")).toMatchObject({
        consumer: "chronicle",
        enabled: true,
        providerId: groom.id,
        model: "groom-model",
        timeoutMs: 42_000,
        isOperational: true,
      });
      expect(resolveConsumerToken(store, "chronicle")).toBe("dummy-groom-token");
      expect(store.getSetting("chronicle.enabled")).toBe("true");
    });

    it("uses its own connection once a Chronicle provider is selected", () => {
      const { store } = s!;
      const groom = addProvider(store, {
        name: "Groom",
        endpoint: "https://groom.example/v1",
        token: "dummy-groom-token",
      });
      const chronicle = addProvider(store, {
        name: "Chronicle",
        endpoint: "https://chronicle.example/v1",
        token: "dummy-chronicle-token",
      });
      writeConsumerConfig(store, "grooming", { providerId: groom.id, model: "groom-model" });
      writeConsumerConfig(store, "chronicle", {
        providerId: chronicle.id,
        model: "chronicle-model",
        timeoutMs: 30_000,
      });

      expect(readConsumerConfig(store, "chronicle")).toMatchObject({
        providerId: chronicle.id,
        endpoint: "https://chronicle.example/v1",
        model: "chronicle-model",
        timeoutMs: 30_000,
      });
      expect(resolveConsumerToken(store, "chronicle")).toBe("dummy-chronicle-token");
    });
  });

  describe("legacy migration", () => {
    const LEGACY_KEYS = llmConnectionKeys("curator.llm");

    function seedLegacy(store: LibrarianStore): void {
      writeLlmConnection(store, LEGACY_KEYS, {
        provider: "openai",
        endpoint: "https://legacy.example/v1",
        model: "legacy-model",
        timeoutMs: 45_000,
        token: "dummy-legacy-token",
      });
    }

    /** True when ANY of the five legacy `curator.llm.*` keys is still present. */
    function legacyKeysPresent(store: LibrarianStore): boolean {
      const keys = store.listSettings().map((m) => m.key);
      return Object.values(LEGACY_KEYS).some((k) => keys.includes(k));
    }

    it("synthesises a `default` provider, points both consumers at it, and deletes the legacy keys", () => {
      const { store } = s!;
      seedLegacy(store);

      expect(migrateLegacyCuratorLlm(store)).toBe(true);

      const providers = listProviders(store);
      expect(providers).toHaveLength(1);
      expect(providers[0].name).toBe("default");
      expect(providers[0].endpoint).toBe("https://legacy.example/v1");
      expect(providers[0].hasToken).toBe(true);

      for (const c of ["intake", "grooming"] as const) {
        const cfg = readConsumerConfig(store, c);
        expect(cfg.providerId).toBe(providers[0].id);
        expect(cfg.model).toBe("legacy-model");
        expect(cfg.timeoutMs).toBe(45_000);
        expect(cfg.isOperational).toBe(true);
        expect(resolveConsumerToken(store, c)).toBe("dummy-legacy-token");
      }

      // The legacy surface is retired: every `curator.llm.*` key is gone once the
      // new consumer config has been seeded from it (no double source of truth).
      expect(legacyKeysPresent(store)).toBe(false);
    });

    it("is idempotent — a second run is a no-op (legacy keys already deleted)", () => {
      const { store } = s!;
      seedLegacy(store);
      expect(migrateLegacyCuratorLlm(store)).toBe(true);
      expect(legacyKeysPresent(store)).toBe(false);
      // Re-run finds no legacy keys AND a provider already exists -> no-op.
      expect(migrateLegacyCuratorLlm(store)).toBe(false);
      expect(listProviders(store)).toHaveLength(1);
    });

    it("does nothing when there is no legacy config", () => {
      const { store } = s!;
      expect(migrateLegacyCuratorLlm(store)).toBe(false);
      expect(listProviders(store)).toEqual([]);
    });

    it("skips when providers already exist", () => {
      const { store } = s!;
      seedLegacy(store);
      addProvider(store, { name: "Existing", endpoint: "https://x.example/v1" });
      expect(migrateLegacyCuratorLlm(store)).toBe(false);
      expect(listProviders(store).map((p) => p.name)).toEqual(["Existing"]);
    });

    it("skips a legacy config that has no endpoint (nothing meaningful to migrate)", () => {
      const { store } = s!;
      writeLlmConnection(store, llmConnectionKeys("curator.llm"), { model: "m", token: "dummy-x" });
      expect(migrateLegacyCuratorLlm(store)).toBe(false);
      expect(listProviders(store)).toEqual([]);
    });

    it("defers without throwing AND preserves the legacy keys when the master key is absent", () => {
      const { store, dataDir } = s!;
      seedLegacy(store); // endpoint + model + token
      store.close();
      // Reopen WITHOUT the master key: the legacy token can't be decrypted. The
      // migration must fail soft (never throw out of a tick) and defer — not
      // half-migrate a token-less provider that would permanently drop the key.
      const keyless = createLibrarianStore({ dataDir });
      try {
        expect(() => migrateLegacyCuratorLlm(keyless)).not.toThrow();
        expect(migrateLegacyCuratorLlm(keyless)).toBe(false);
        expect(listProviders(keyless)).toEqual([]);
        // CRITICAL — no data loss: the legacy keys MUST survive the deferral so a
        // later tick (master key restored) can still migrate them. Deletion only
        // ever fires on the confirmed-success path, after the seed.
        expect(legacyKeysPresent(keyless)).toBe(true);
      } finally {
        keyless.close();
      }
    });
  });
});

// Shared LLM-connection helper — round-trip read/write, key-prefix isolation,
// secret-token plumbing, timeoutMs validation. Each LLM consumer (e.g. the
// curator) composes this helper with its own keyspace prefix.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type LibrarianStore,
  createLibrarianStore,
  llmConnectionKeys,
  readLlmConnection,
  resolveLlmToken,
  resolveSecretKey,
  writeLlmConnection,
} from "@librarian/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const KEY = resolveSecretKey("00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff");

interface Scope {
  store: LibrarianStore;
  dataDir: string;
}

function scope(): Scope {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-llm-conn-"));
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

describe("llm-connection helper", () => {
  let s: Scope | null = null;
  beforeEach(() => {
    s = scope();
  });
  afterEach(() => {
    teardown(s);
    s = null;
  });

  describe("llmConnectionKeys", () => {
    it("derives the five settings keys under a prefix", () => {
      expect(llmConnectionKeys("curator.llm")).toEqual({
        provider: "curator.llm.provider",
        endpoint: "curator.llm.endpoint",
        model: "curator.llm.model",
        timeoutMs: "curator.llm.timeout_ms",
        token: "curator.llm.token",
      });
      expect(llmConnectionKeys("intake.llm")).toEqual({
        provider: "intake.llm.provider",
        endpoint: "intake.llm.endpoint",
        model: "intake.llm.model",
        timeoutMs: "intake.llm.timeout_ms",
        token: "intake.llm.token",
      });
    });
  });

  describe("readLlmConnection", () => {
    it("returns empty defaults when nothing is stored", () => {
      const { store } = s!;
      const got = readLlmConnection(store, llmConnectionKeys("test.llm"));
      expect(got.provider).toBe("");
      expect(got.endpoint).toBe("");
      expect(got.model).toBe("");
      expect(got.timeoutMs).toBe(300_000); // default
      expect(got.hasToken).toBe(false);
      expect(got.isComplete).toBe(false);
    });

    it("rolls timeoutMs back to default when an unparseable value is stored", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      store.setSetting(keys.timeoutMs, "not-a-number");
      expect(readLlmConnection(store, keys).timeoutMs).toBe(300_000);
    });

    it("never returns the token plaintext — only hasToken", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      writeLlmConnection(store, keys, {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        timeoutMs: 30_000,
        token: "dummy-secret-do-not-leak",
      });
      const got = readLlmConnection(store, keys);
      expect(got.hasToken).toBe(true);
      // No `token` field in the shape at all.
      expect(Object.keys(got)).not.toContain("token");
      // And no value shows up via any property.
      expect(JSON.stringify(got)).not.toContain("dummy-secret");
    });

    it("flags isComplete only when provider + endpoint + model + token are all present", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      writeLlmConnection(store, keys, {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      });
      expect(readLlmConnection(store, keys).isComplete).toBe(false); // no token yet
      writeLlmConnection(store, keys, { token: "dummy-token-x" });
      expect(readLlmConnection(store, keys).isComplete).toBe(true);
    });
  });

  describe("writeLlmConnection", () => {
    it("round-trips every field", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      writeLlmConnection(store, keys, {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        timeoutMs: 45_000,
        token: "dummy-token-x",
      });
      const got = readLlmConnection(store, keys);
      expect(got.provider).toBe("openai");
      expect(got.endpoint).toBe("https://api.openai.com/v1");
      expect(got.model).toBe("gpt-4o-mini");
      expect(got.timeoutMs).toBe(45_000);
      expect(got.hasToken).toBe(true);
    });

    it("treats an empty-string token as a clear, not a write", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      writeLlmConnection(store, keys, { token: "dummy-token-x" });
      expect(readLlmConnection(store, keys).hasToken).toBe(true);
      writeLlmConnection(store, keys, { token: "" });
      expect(readLlmConnection(store, keys).hasToken).toBe(false);
    });

    it("only writes the fields present in the patch", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      writeLlmConnection(store, keys, {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
      });
      writeLlmConnection(store, keys, { model: "gpt-4o" }); // partial
      const got = readLlmConnection(store, keys);
      expect(got.provider).toBe("openai");
      expect(got.endpoint).toBe("https://api.openai.com/v1");
      expect(got.model).toBe("gpt-4o");
    });

    it("rejects an out-of-bounds timeoutMs", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      expect(() => writeLlmConnection(store, keys, { timeoutMs: 0 })).toThrow(/timeout/i);
      expect(() => writeLlmConnection(store, keys, { timeoutMs: 999 })).toThrow(/timeout/i);
      expect(() => writeLlmConnection(store, keys, { timeoutMs: 600_001 })).toThrow(/timeout/i);
      expect(() => writeLlmConnection(store, keys, { timeoutMs: 1.5 })).toThrow(/timeout/i);
    });
  });

  describe("key-prefix isolation", () => {
    it("writes under one prefix do not leak into another", () => {
      const { store } = s!;
      const curator = llmConnectionKeys("curator.llm");
      const intake = llmConnectionKeys("intake.llm");

      writeLlmConnection(store, curator, {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        token: "dummy-curator-token",
      });

      const curatorGot = readLlmConnection(store, curator);
      const intakeGot = readLlmConnection(store, intake);

      expect(curatorGot.isComplete).toBe(true);
      expect(intakeGot.provider).toBe("");
      expect(intakeGot.endpoint).toBe("");
      expect(intakeGot.model).toBe("");
      expect(intakeGot.hasToken).toBe(false);
      expect(intakeGot.isComplete).toBe(false);
    });
  });

  describe("resolveLlmToken", () => {
    it("returns the decrypted token plaintext when present, null when not", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      expect(resolveLlmToken(store, keys)).toBeNull();
      writeLlmConnection(store, keys, { token: "dummy-resolved-token" });
      expect(resolveLlmToken(store, keys)).toBe("dummy-resolved-token");
    });

    it("returns null after the token is cleared", () => {
      const { store } = s!;
      const keys = llmConnectionKeys("test.llm");
      writeLlmConnection(store, keys, { token: "dummy-token-x" });
      writeLlmConnection(store, keys, { token: "" });
      expect(resolveLlmToken(store, keys)).toBeNull();
    });
  });
});

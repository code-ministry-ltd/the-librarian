// Secret redaction for curator evidence (memory-curator spec §9).
//
// Evidence (memory bodies, session summaries, commands run, file paths,
// metadata) must have secret-looking material redacted BEFORE prompt
// construction — "do not wait until output validation to catch secrets; by
// then the sensitive value may already have been sent to an LLM." This is the
// conservative known-format + assignment redactor behind that boundary.
//
// Fixtures use obviously-synthetic, zero-entropy values (repeated `X`/`0`,
// `FAKE…`) so they exercise the FORMAT detection without tripping secret
// scanners (GitHub push protection / GitGuardian) on what are not real secrets.

import { redactSecrets, redactSecretsWithSourceMap } from "@librarian/core";
import { describe, expect, it } from "vitest";

const X = "X".repeat(40); // long synthetic filler — satisfies any length floor

describe("redactSecrets", () => {
  it("maps unredacted UTF-16 code units and marks replacement output unmappable", () => {
    const source = `😀 Keep. API_KEY=${X} Stale.`;
    const mapped = redactSecretsWithSourceMap(source);
    const plain = redactSecrets(source);
    const markerStart = mapped.redacted.indexOf("[REDACTED:secret]");
    const staleStart = mapped.redacted.indexOf("Stale.");

    expect(mapped.redacted).toBe(plain.redacted);
    expect(mapped.count).toBe(plain.count);
    expect(mapped.sourceOffsetByOutputIndex.slice(markerStart, markerStart + 16)).toEqual(
      Array(16).fill(null),
    );
    expect(mapped.sourceOffsetByOutputIndex.slice(staleStart, staleStart + 6)).toEqual(
      Array.from({ length: 6 }, (_, offset) => source.indexOf("Stale.") + offset),
    );
  });

  it("redacts large inputs without overflowing while copying source maps", () => {
    const prefix = "x".repeat(150_000);
    const key = ["api", "key"].join("_");
    const source = `${prefix} ${key}=${"A".repeat(40)} tail`;

    const plain = redactSecrets(source);
    const mapped = redactSecretsWithSourceMap(source);
    const expected = `${prefix} ${key}=[REDACTED:secret] tail`;
    const tailStart = mapped.redacted.indexOf("tail");

    expect(plain).toEqual({ redacted: expected, count: 1 });
    expect(mapped.redacted).toBe(expected);
    expect(mapped.count).toBe(1);
    expect(mapped.sourceOffsetByOutputIndex).toHaveLength(expected.length);
    expect(mapped.sourceOffsetByOutputIndex.slice(tailStart, tailStart + 4)).toEqual(
      Array.from({ length: 4 }, (_, offset) => source.indexOf("tail") + offset),
    );
  });

  it("leaves clean text untouched and reports zero redactions", () => {
    const { redacted, count } = redactSecrets("A normal memory about the deploy process.");
    expect(redacted).toBe("A normal memory about the deploy process.");
    expect(count).toBe(0);
  });

  it("redacts a PEM private key block", () => {
    const input = `key:\n-----BEGIN RSA PRIVATE KEY-----\n${X}\n${X}\n-----END RSA PRIVATE KEY-----\ndone`;
    const { redacted, count } = redactSecrets(input);
    expect(redacted).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(redacted).not.toContain(X);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).toContain("done");
  });

  it("redacts common provider token formats", () => {
    const cases = [
      `sk-${X}`,
      `sk-ant-${X}`,
      `ghp_${X}`,
      `AKIA${"X".repeat(16)}`,
      `xoxb-${"0".repeat(10)}-${"X".repeat(12)}`,
      `AIza${X}`,
    ];
    for (const secret of cases) {
      const { redacted, count } = redactSecrets(`token is ${secret} ok`);
      expect(redacted, secret).not.toContain(secret);
      expect(count, secret).toBeGreaterThanOrEqual(1);
    }
  });

  it("redacts a JWT", () => {
    const jwt = `eyJ${"X".repeat(12)}.${"X".repeat(12)}.${"X".repeat(12)}`;
    const { redacted } = redactSecrets(`auth: ${jwt}`);
    expect(redacted).not.toContain(jwt);
  });

  it("redacts a Bearer token but keeps the surrounding label", () => {
    const token = `sk-${X}`;
    const { redacted } = redactSecrets(`Authorization: Bearer ${token}`);
    expect(redacted).toContain("Authorization:");
    expect(redacted).not.toContain(token);
  });

  it("redacts the value of a secret-like assignment, keeping the key for context", () => {
    const { redacted } = redactSecrets("API_KEY=supersecretvalue123  PASSWORD: hunter2hunter2");
    expect(redacted).toContain("API_KEY");
    expect(redacted).not.toContain("supersecretvalue123");
    expect(redacted).not.toContain("hunter2hunter2");
  });

  it("redacts a quoted assignment value that contains spaces (no fail-open)", () => {
    const { redacted, count } = redactSecrets('api_key = "  spaced secret value here"');
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).not.toContain("spaced secret value here");
    expect(redacted).toContain("api_key");
    // single-quoted too
    expect(redactSecrets("token = 'abc def ghi'").redacted).not.toContain("abc def ghi");
  });

  it("redacts Stripe keys (underscore-separated)", () => {
    const fake = "sk_test_FAKEKEYFAKEKEYFAKEKEY0";
    const { redacted, count } = redactSecrets(`STRIPE=${fake}`);
    expect(count).toBeGreaterThanOrEqual(1);
    expect(redacted).not.toContain(fake);
  });

  it("redacts basic-auth credentials in URLs, keeping scheme + user", () => {
    const { redacted } = redactSecrets(
      "git clone https://admin:fakepassword00@github.com/org/repo",
    );
    expect(redacted).toContain("https://admin:");
    expect(redacted).not.toContain("fakepassword00");
    const db = redactSecrets("postgres://dbuser:fakedbpass00@db.host:5432/mydb").redacted;
    expect(db).not.toContain("fakedbpass00");
    expect(db).toContain("postgres://dbuser:");
  });

  it("redacts GitLab / npm / PyPI tokens", () => {
    const cases = [`glpat-${"X".repeat(20)}`, `npm_${"X".repeat(36)}`, `pypi-${"X".repeat(16)}`];
    for (const secret of cases) {
      expect(redactSecrets(`tok ${secret} end`).redacted, secret).not.toContain(secret);
    }
  });

  it("is idempotent — re-redacting already-redacted text finds nothing (count 0)", () => {
    const first = redactSecrets(`api_key="supersecretvalue" and ghp_${"X".repeat(36)}`);
    expect(first.count).toBeGreaterThanOrEqual(2);
    const second = redactSecrets(first.redacted);
    expect(second.count).toBe(0);
    expect(second.redacted).toBe(first.redacted);
  });

  it("does not redact ordinary high-length identifiers (git SHA, UUID)", () => {
    // Entropy-based detection is deferred (v2) precisely to avoid nuking these.
    const sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const { redacted, count } = redactSecrets(`commit ${sha} for ${uuid}`);
    expect(redacted).toContain(sha);
    expect(redacted).toContain(uuid);
    expect(count).toBe(0);
  });

  it("counts multiple redactions", () => {
    const { count } = redactSecrets(`ghp_${"X".repeat(36)} and AKIA${"X".repeat(16)}`);
    expect(count).toBe(2);
  });
});

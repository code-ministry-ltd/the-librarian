// Curator guards (spec 075 §4, ADR 0015): deterministic checks that refuse a
// curator write which would grow a memory past the size cap or silently drop
// specific detail (ports, versions, paths, identifiers) from its sources.

import {
  GUARD_DETAIL_REASON_PREFIX,
  GUARD_SIZE_REASON,
  MAX_MEMORY_BODY_CHARS,
  checkDetailGuard,
  checkSizeGuard,
  distinctiveTokens,
} from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("distinctiveTokens", () => {
  it("keeps specific identifiers and drops ordinary words", () => {
    const tokens = distinctiveTokens(
      "The baruch-server listens on port 8034 via llama.cpp; see run-strata.sh and maxTokens.",
    );
    expect([...tokens].sort()).toEqual(
      ["8034", "baruch-server", "llama.cpp", "maxtokens", "run-strata.sh"].sort(),
    );
  });

  it("ignores memory ids, ISO dates and UUIDs, which change without meaning anything", () => {
    const tokens = distinctiveTokens(
      "Merged mem_1fef3068-20cf-42dd-941d-1682388dbdc9 on 2026-10-12, run 1fef3068-20cf-42dd-941d-1682388dbdc9.",
    );
    expect([...tokens]).toEqual([]);
  });
});

describe("checkSizeGuard", () => {
  const body = (n: number): string => "x".repeat(n);

  it("allows a new body up to the cap and refuses one over it", () => {
    expect(checkSizeGuard(body(MAX_MEMORY_BODY_CHARS - 1))).toBeNull();
    expect(checkSizeGuard(body(MAX_MEMORY_BODY_CHARS))).toBeNull();
    expect(checkSizeGuard(body(MAX_MEMORY_BODY_CHARS + 1))).toBe(GUARD_SIZE_REASON);
  });

  it("lets an over-cap memory shrink or stay the same, but never grow", () => {
    expect(checkSizeGuard(body(9000), 10000)).toBeNull();
    expect(checkSizeGuard(body(10000), 10000)).toBeNull();
    expect(checkSizeGuard(body(10001), 10000)).toBe(GUARD_SIZE_REASON);
  });
});

describe("checkDetailGuard", () => {
  const sources = [
    "Ports: api 3838, dashboard 3000, baruch-server 8034, grafana 9126. " +
      "Models: qwen3.8-27b, gemma-4-e4b, h2o-lightning-4b. Scripts: run-strata.sh, tabby-qwen.sh, " +
      "switch-profile.sh, start-hermes-dashboard.sh, models.json, llama-swap.yaml, " +
      "docker-compose.yml, pm2.config.js, agentenv/secrets.env, v0.1.40, v1.31.1, cuda13, gpu0, gpu1, 127.0.0.1:8041",
  ];

  it("passes a result that keeps every specific detail", () => {
    expect(checkDetailGuard(sources, [sources[0] ?? ""])).toBeNull();
  });

  it("allows a small loss: at most three terms, or 10% when there are more than 30", () => {
    const result = (sources[0] ?? "").replace("3838", "").replace("9126", "").replace("gpu0", "");
    expect(checkDetailGuard(sources, [result])).toBeNull();
  });

  it("refuses a result that drops more than the allowance, naming how many were lost", () => {
    const result = "Ports: api 3838. Models: qwen3.8-27b.";
    const reason = checkDetailGuard(sources, [result]);
    expect(reason?.startsWith(GUARD_DETAIL_REASON_PREFIX)).toBe(true);
    expect(reason).toMatch(/\(\d+ distinctive terms dropped\)$/);
  });

  it("does not count terms the correction itself names as wrongly dropped", () => {
    const result = "Ports: api 3838.";
    const correction = sources[0] ?? ""; // the submission or flag reason mentions every term
    expect(checkDetailGuard(sources, [result], [correction])).toBeNull();
  });

  it("lets a rewrite drop up to half the terms (de-brittling, corrections) but refuses gutting", () => {
    const all = sources[0] ?? "";
    const tokens = [...distinctiveTokens(all)];
    const keepHalf = tokens.slice(0, Math.ceil(tokens.length / 2)).join(" ");
    expect(checkDetailGuard(sources, [keepHalf], [], "rewrite")).toBeNull();
    expect(checkDetailGuard(sources, [keepHalf], [], "restructure")).not.toBeNull();
    const keepFew = tokens.slice(0, 3).join(" ");
    expect(checkDetailGuard(sources, [keepFew], [], "rewrite")).not.toBeNull();
  });

  it("finds a term in any of several results (a split)", () => {
    const all = sources[0] ?? "";
    const cut = all.indexOf(" Scripts:");
    const [first, second] = [all.slice(0, cut), all.slice(cut)];
    expect(checkDetailGuard(sources, [first, second])).toBeNull();
  });
});

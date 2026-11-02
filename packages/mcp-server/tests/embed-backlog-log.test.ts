// The server's log policy for embedding cache misses: routine one-memory rebuilds stay at
// debug, a large batch (cold cache, big new reference) is announced at info before and
// after, and a failed batch is a warning. Lines carry counts and timing only.

import { describe, expect, it } from "vitest";
import { LARGE_BATCH_CHUNKS, logEmbedBacklog } from "../dist/embed-backlog-log.js";

function recordingLogger() {
  const lines: { level: string; details: object; msg: string }[] = [];
  const at =
    (level: string) =>
    (details: object, msg: string): void => {
      lines.push({ level, details, msg });
    };
  return { lines, logger: { debug: at("debug"), info: at("info"), warn: at("warn") } };
}

describe("logEmbedBacklog", () => {
  it("announces a large miss batch at info, with its size up front and its duration after", () => {
    const { lines, logger } = recordingLogger();
    logEmbedBacklog(logger, { phase: "start", scope: "references", files: 6, chunks: 180 });
    logEmbedBacklog(logger, {
      phase: "done",
      scope: "references",
      files: 6,
      chunks: 180,
      durationMs: 5_412_000,
      failed: false,
    });
    expect(lines.map((l) => l.level)).toEqual(["info", "info"]);
    expect(lines[0]!.msg).toContain("embedding 180 chunk(s) from 6 references file(s)");
    expect(lines[1]!.msg).toContain("in 5412s");
    expect(lines[1]!.details).toEqual({
      scope: "references",
      files: 6,
      chunks: 180,
      durationMs: 5_412_000,
    });
  });

  it("keeps a routine small rebuild (e.g. after one remember) at debug", () => {
    const { lines, logger } = recordingLogger();
    logEmbedBacklog(logger, {
      phase: "start",
      scope: "memories",
      files: 1,
      chunks: LARGE_BATCH_CHUNKS - 1,
    });
    logEmbedBacklog(logger, {
      phase: "done",
      scope: "memories",
      files: 1,
      chunks: LARGE_BATCH_CHUNKS - 1,
      durationMs: 1_200,
      failed: false,
    });
    expect(lines.map((l) => l.level)).toEqual(["debug", "debug"]);
  });

  it("warns when a batch stops after an error, whatever its size", () => {
    const { lines, logger } = recordingLogger();
    logEmbedBacklog(logger, {
      phase: "done",
      scope: "memories",
      files: 1,
      chunks: 2,
      durationMs: 300,
      failed: true,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe("warn");
    expect(lines[0]!.msg).toContain("stopped after an error");
  });
});

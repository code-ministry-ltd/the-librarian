// Transcript-intake: the harness-agnostic capture door (spec
// 2026-06-16-harness-auto-capture, T1). In-process unit coverage of the pure
// handler over a real LibrarianStore — fast + deterministic, no spawned server.
//
//   - SC11 (contract): a well-formed delta is accepted + buffered; a malformed
//     payload is a 400; a SECOND (mock) harness validates against the SAME
//     contract (the payload is harness-agnostic).
//   - SC5 (redaction): a secret-shaped turn is redacted in the buffer file; the
//     raw secret never appears on disk. (The fixture is assembled at runtime
//     from sub-parts so it can't trip GitGuardian — AGENTS.md.)
//   - SC6 (write path): the buffer lands in the data-dir `transcripts/` sidecar,
//     OUTSIDE the git vault; a path-traversal conv_id is neutralized.
//   - gate-refuse: with curator.intake.enabled false, NOTHING is written and the
//     response signals capture is disabled.
//
// Imports the COMPILED module: vitest externalizes packages/mcp-server/{src,dist}
// (vitest.config.ts), so a `../src/*.ts` import hits Node's loader, which can't
// load .ts. dist is built before test:vitest runs (test script does `pnpm build`).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { INTAKE_ENABLED_KEY, type LibrarianStore, createLibrarianStore } from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  TRANSCRIPT_HARD_MAX_BYTES,
  endedMarkerPath,
  handleTranscriptIntake,
  sanitizeConvId,
  transcriptBufferPath,
  transcriptHarnessMarkerPath,
} from "../../dist/http/transcript-intake.js";

let store: LibrarianStore | null = null;
let dataDir = "";

function makeStore(intakeEnabled: boolean): LibrarianStore {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-transcript-"));
  store = createLibrarianStore({ dataDir });
  store.setSetting(INTAKE_ENABLED_KEY, intakeEnabled ? "true" : "false");
  return store;
}

afterEach(() => {
  try {
    store?.close();
  } catch {
    /* ignore */
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  store = null;
  dataDir = "";
});

// A well-formed delta for a given harness. Kept tiny + explicit so each test
// asserts against a known shape.
function delta(over: Record<string, unknown> = {}) {
  return {
    conv_id: "conv-abc",
    harness: "claude",
    seq: 0,
    turns: [
      { role: "user", text: "how do I run the tests?" },
      { role: "assistant", text: "use pnpm test" },
    ],
    ...over,
  };
}

describe("transcript-intake — uniform contract (SC11)", () => {
  it("accepts a well-formed delta and buffers the turns", () => {
    const s = makeStore(true);
    const res = handleTranscriptIntake(s, delta());
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.buffered).toBe(2);

    const buffer = fs.readFileSync(transcriptBufferPath(dataDir, "conv-abc"), "utf8");
    expect(buffer).toContain("how do I run the tests?");
    expect(buffer).toContain("use pnpm test");
    expect(
      JSON.parse(fs.readFileSync(transcriptHarnessMarkerPath(dataDir, "conv-abc"), "utf8")),
    ).toEqual({
      harness: "claude",
    });
  });

  it("rejects a malformed payload with a 400 and a teaching error (and buffers nothing)", () => {
    const s = makeStore(true);
    // `turns` is the wrong type, and `seq` is missing — a malformed adapter.
    const res = handleTranscriptIntake(s, { conv_id: "c", harness: "claude", turns: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.accepted).toBe(false);
    expect(typeof res.body.error).toBe("string");

    // Nothing was written for the bad payload.
    expect(fs.existsSync(path.join(dataDir, "transcripts"))).toBe(false);
  });

  it("rejects an invalid turn role with a 400 (the contract pins the role enum)", () => {
    const s = makeStore(true);
    const res = handleTranscriptIntake(s, delta({ turns: [{ role: "system", text: "x" }] }));
    expect(res.status).toBe(400);
  });

  it("validates a SECOND (mock) harness against the SAME contract", () => {
    const s = makeStore(true);
    // A different harness value, same payload shape — the contract is
    // harness-agnostic (the whole point of SC11).
    const res = handleTranscriptIntake(
      s,
      delta({ harness: "mock-harness", conv_id: "conv-mock", seq: 7 }),
    );
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    const buffer = fs.readFileSync(transcriptBufferPath(dataDir, "conv-mock"), "utf8");
    expect(buffer).toContain("use pnpm test");
  });

  it("appends forward-only across successive deltas (no overwrite)", () => {
    const s = makeStore(true);
    handleTranscriptIntake(s, delta({ seq: 0, turns: [{ role: "user", text: "first turn" }] }));
    handleTranscriptIntake(s, delta({ seq: 1, turns: [{ role: "user", text: "second turn" }] }));

    const buffer = fs.readFileSync(transcriptBufferPath(dataDir, "conv-abc"), "utf8");
    expect(buffer).toContain("first turn");
    expect(buffer).toContain("second turn");
    // Forward-only: the first turn survives the second append.
    expect(buffer.indexOf("first turn")).toBeLessThan(buffer.indexOf("second turn"));
  });
});

describe("transcript-intake — redaction on intake (SC5)", () => {
  it("redacts a secret-shaped turn in the buffer; the raw secret never reaches disk", () => {
    const s = makeStore(true);
    // Assemble a secret-shaped string at RUNTIME from sub-threshold parts so the
    // literal is never in committed source (AGENTS.md GitGuardian note). This
    // matches the redactor's `key = "value"` assignment rule.
    const kw = ["api", "key"].join("_");
    const val = `${"ABCDEF0123456789".toLowerCase()}${"ABCDEF0123456789".toLowerCase()}`;
    const secretLine = `${kw} = "${val}"`;

    const res = handleTranscriptIntake(
      s,
      delta({
        turns: [{ role: "assistant", text: `here is the config: ${secretLine}` }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    const onDisk = fs.readFileSync(transcriptBufferPath(dataDir, "conv-abc"), "utf8");
    // The redaction marker is present...
    expect(onDisk).toContain("[REDACTED:secret]");
    // ...and the raw secret value is NOT anywhere on disk.
    expect(onDisk).not.toContain(val);
  });
});

describe("transcript-intake — write-path hygiene (SC6)", () => {
  it("buffers into the data-dir transcripts/ sidecar, NOT inside the git vault", () => {
    const s = makeStore(true);
    handleTranscriptIntake(s, delta());

    const bufferPath = transcriptBufferPath(dataDir, "conv-abc");
    // The buffer is at <data-dir>/transcripts/<conv_id>.md ...
    expect(bufferPath).toBe(path.join(dataDir, "transcripts", "conv-abc.md"));
    expect(fs.existsSync(bufferPath)).toBe(true);
    // ... NOT inside the git-tracked vault subdir.
    expect(bufferPath.includes(`${path.sep}vault${path.sep}`)).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "vault", "transcripts"))).toBe(false);
  });

  it("neutralizes a path-traversal conv_id so the write stays inside transcripts/", () => {
    const s = makeStore(true);
    const evil = "../../etc/passwd";
    const res = handleTranscriptIntake(s, delta({ conv_id: evil }));
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);

    // The sanitized id has no path separators and can't escape transcripts/.
    const safe = sanitizeConvId(evil);
    expect(safe.includes("/")).toBe(false);
    expect(safe.includes("\\")).toBe(false);
    expect(safe.startsWith(".")).toBe(false);

    const written = transcriptBufferPath(dataDir, evil);
    const transcriptsDir = path.join(dataDir, "transcripts");
    // The resolved file is contained within transcripts/.
    expect(path.resolve(written).startsWith(path.resolve(transcriptsDir) + path.sep)).toBe(true);
    expect(fs.existsSync(written)).toBe(true);
    // No file escaped to the parent of the data dir.
    expect(fs.existsSync(path.resolve(dataDir, "..", "etc", "passwd"))).toBe(false);
  });
});

describe("transcript-intake — server-side private backstop (AGENTS.md: never bypass private mode)", () => {
  it("skips a private-marked turn but buffers the other turns in the same delta", () => {
    const s = makeStore(true);
    const res = handleTranscriptIntake(
      s,
      delta({
        turns: [
          { role: "user", text: "public question one" },
          { role: "user", text: "secret stuff [librarian:private=on] do not capture" },
          { role: "assistant", text: "public answer two" },
        ],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    // Only the two public turns were buffered; the private one was dropped.
    expect(res.body.buffered).toBe(2);

    const buffer = fs.readFileSync(transcriptBufferPath(dataDir, "conv-abc"), "utf8");
    expect(buffer).toContain("public question one");
    expect(buffer).toContain("public answer two");
    // The private turn's text never reached the buffer.
    expect(buffer).not.toContain("do not capture");
    expect(buffer).not.toContain("secret stuff");
  });

  it("buffers nothing when every turn in the delta is private", () => {
    const s = makeStore(true);
    const res = handleTranscriptIntake(
      s,
      delta({
        turns: [{ role: "user", text: "[librarian:private=on] all of this is private" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.buffered).toBe(0);
    // An all-private delta writes no buffer content (the dir may be created but the
    // file is empty / the private text never lands).
    const bufferPath = transcriptBufferPath(dataDir, "conv-abc");
    if (fs.existsSync(bufferPath)) {
      expect(fs.readFileSync(bufferPath, "utf8")).not.toContain("all of this is private");
    }
  });
});

describe("transcript-intake — hard append cap (DoS backstop)", () => {
  it("stops appending once the buffer exceeds the hard cap and signals it (no throw)", () => {
    const s = makeStore(true);
    const bufferPath = transcriptBufferPath(dataDir, "conv-fat");
    fs.mkdirSync(path.dirname(bufferPath), { recursive: true });
    // Pre-fill the buffer ABOVE the hard cap so the next append must be refused.
    fs.writeFileSync(bufferPath, "x".repeat(TRANSCRIPT_HARD_MAX_BYTES + 1), "utf8");
    const sizeBefore = fs.statSync(bufferPath).size;

    const res = handleTranscriptIntake(
      s,
      delta({ conv_id: "conv-fat", turns: [{ role: "user", text: "one more turn please" }] }),
    );

    expect(res.status).toBe(200);
    // The append was refused cleanly — not accepted, with a reason, no throw.
    expect(res.body.accepted).toBe(false);
    expect(String(res.body.reason)).toMatch(/cap|size|large|limit/i);
    // The buffer did not grow — the new turn was not appended.
    expect(fs.statSync(bufferPath).size).toBe(sizeBefore);
    const onDisk = fs.readFileSync(bufferPath, "utf8");
    expect(onDisk).not.toContain("one more turn please");
  });

  it("appends normally while the buffer is under the hard cap", () => {
    const s = makeStore(true);
    const res = handleTranscriptIntake(s, delta({ conv_id: "conv-small" }));
    expect(res.body.accepted).toBe(true);
    expect(res.body.buffered).toBe(2);
  });
});

describe("transcript-intake — explicit-end marker (T2 accelerator)", () => {
  it("drops a sibling .ended marker when the delta carries ended:true", () => {
    const s = makeStore(true);
    const res = handleTranscriptIntake(s, delta({ ended: true }));
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(true);
    expect(res.body.ended).toBe(true);

    // The buffer AND the end marker sit side by side in transcripts/.
    expect(fs.existsSync(transcriptBufferPath(dataDir, "conv-abc"))).toBe(true);
    expect(fs.existsSync(endedMarkerPath(dataDir, "conv-abc"))).toBe(true);
  });

  it("writes NO end marker for an ordinary (non-ended) delta", () => {
    const s = makeStore(true);
    handleTranscriptIntake(s, delta());
    expect(fs.existsSync(transcriptBufferPath(dataDir, "conv-abc"))).toBe(true);
    expect(fs.existsSync(endedMarkerPath(dataDir, "conv-abc"))).toBe(false);
  });
});

describe("transcript-intake — gate-refuse (curator.intake.enabled off)", () => {
  it("writes nothing and signals capture is disabled when the intake gate is off", () => {
    const s = makeStore(false);
    const res = handleTranscriptIntake(s, delta());
    expect(res.status).toBe(200);
    expect(res.body.accepted).toBe(false);
    expect(res.body.disabled).toBe(true);
    expect(String(res.body.reason)).toMatch(/disabled|intake/i);

    // The buffer dir was never created — nothing at rest for a dead pipeline.
    expect(fs.existsSync(path.join(dataDir, "transcripts"))).toBe(false);
  });
});

describe("handleTranscriptIntake — optional project (spec 077 §4.8)", () => {
  it("records the project beside the harness in the write-once capture marker", () => {
    const s = makeStore(true);
    const out = handleTranscriptIntake(s, delta({ project: "the-librarian" }));
    expect(out.status).toBe(200);
    const marker = JSON.parse(
      fs.readFileSync(transcriptHarnessMarkerPath(dataDir, "conv-abc"), "utf8"),
    );
    expect(marker).toEqual({ harness: "claude", project: "the-librarian" });
  });

  it("keeps the marker unchanged for a delta without a project", () => {
    const s = makeStore(true);
    handleTranscriptIntake(s, delta());
    const marker = JSON.parse(
      fs.readFileSync(transcriptHarnessMarkerPath(dataDir, "conv-abc"), "utf8"),
    );
    expect(marker).toEqual({ harness: "claude" });
  });

  it("refuses an over-long project with a teaching 400", () => {
    const s = makeStore(true);
    const out = handleTranscriptIntake(s, delta({ project: "p".repeat(201) }));
    expect(out.status).toBe(400);
    expect(String(out.body.error)).toContain('"project"');
  });
});

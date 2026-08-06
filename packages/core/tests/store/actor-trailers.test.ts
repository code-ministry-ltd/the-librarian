// Actor persistence + trailers (spec 064 T4 / SC 4, and SC 3's trailered half).
//
// The substrate's promise: every actor-bearing write carries a sanitised
// `Librarian-Actor` git trailer naming the acting principal — so the audit export
// can finally answer "who successfully changed what". This drives each verb through
// the real store (which wires the real git committer) and reads the trailer straight
// off the commit with the same keyed format the reader will use.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type LibrarianStore, type LlmClient, createLibrarianStore } from "@librarian/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectRecord,
  projectSuggestionRecord,
  projectUpdateRecord,
} from "../fixtures/project-records.js";

const dataDirs: string[] = [];
afterEach(() => {
  for (const dir of dataDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function freshStore(): { store: LibrarianStore; vaultRoot: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-trailers-"));
  dataDirs.push(dataDir);
  return { store: createLibrarianStore({ dataDir }), vaultRoot: path.join(dataDir, "vault") };
}

const gitIn = (root: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
/** The `Librarian-Actor` trailer of HEAD (empty string = untrailered / honest null). */
const trailer = (root: string): string =>
  gitIn(root, ["log", "-1", "--format=%(trailers:key=Librarian-Actor,valueonly)"]);
const subject = (root: string): string => gitIn(root, ["log", "-1", "--format=%s"]);
/** The `updated_by:` frontmatter line of a memory doc, or "" when absent. */
const updatedByOf = (root: string, rel: string): string => {
  const raw = fs.readFileSync(path.join(root, rel), "utf8");
  return raw.match(/^updated_by:\s*(.+)$/m)?.[1]?.trim() ?? "";
};

const HANDOFF_DOC = [
  "## Start & intent",
  "Pick up the migration.",
  "## Journey",
  "Mapped the claims.",
  "## Current state",
  "Compiles.",
  "## What's left",
  "Cut over.",
  "## Open questions",
  "Keep the cookie?",
].join("\n\n");

describe("actor trailers on every verb (spec 064 T4 / SC 4)", () => {
  it("memory verbs each trailer the acting principal", () => {
    const { store, vaultRoot } = freshStore();

    const created = store.createMemory({ agent_id: "alice", title: "Runbook", body: "deploy" });
    const id = created.memory.id;
    expect(trailer(vaultRoot)).toBe("alice"); // create → the creator

    store.updateMemory(id, { body: "deploy v2" }, "bob");
    expect(trailer(vaultRoot)).toBe("bob");

    store.archiveMemory(id, "carol");
    expect(trailer(vaultRoot)).toBe("carol");

    store.unarchiveMemory(id, "dave");
    expect(trailer(vaultRoot)).toBe("dave");

    store.flagMemory(id, "stale", "eve");
    expect(trailer(vaultRoot)).toBe("eve");

    store.resolveFlags(id, "frank");
    expect(trailer(vaultRoot)).toBe("frank");

    store.bulkUpdateMemory({ ids: [id], patch: { agent_id: "newowner" }, agent_id: "grace" });
    expect(trailer(vaultRoot)).toBe("grace");

    store.archiveMemory(id, "heidi");
    store.purgeMemory(id, "ivan");
    expect(subject(vaultRoot)).toMatch(/^memory: purge /);
    expect(trailer(vaultRoot)).toBe("ivan");

    // Proposal lifecycle: propose (creator) → reject / approve / resolve (adjudicator).
    const p1 = store.createMemory(
      { agent_id: "judy", title: "P1", body: "x" },
      { requires_approval: true },
    );
    expect(subject(vaultRoot)).toMatch(/^memory: propose /);
    expect(trailer(vaultRoot)).toBe("judy");
    store.approveProposal(p1.memory.id, "reject", {}, "mallory");
    expect(subject(vaultRoot)).toMatch(/^memory: reject /);
    expect(trailer(vaultRoot)).toBe("mallory");

    const p2 = store.createMemory(
      { agent_id: "judy", title: "P2", body: "y" },
      { requires_approval: true },
    );
    store.approveProposal(p2.memory.id, "approve", {}, "niaj");
    expect(subject(vaultRoot)).toMatch(/^memory: approve /);
    expect(trailer(vaultRoot)).toBe("niaj");

    const p3 = store.createMemory(
      { agent_id: "judy", title: "P3", body: "z" },
      { requires_approval: true },
    );
    store.resolveProposal(p3.memory.id, "applied_plan", "olivia");
    expect(subject(vaultRoot)).toMatch(/^memory: resolve /);
    expect(trailer(vaultRoot)).toBe("olivia");

    store.close();
  });

  it("handoff, inbox, vault-file, primer and curator verbs trailer the acting principal", () => {
    const { store, vaultRoot } = freshStore();

    const stored = store.handoffs.store(
      { title: "H", document_md: HANDOFF_DOC },
      { created_by_agent_id: "alice" },
    );
    expect(trailer(vaultRoot)).toBe("alice");
    store.handoffs.claim({ handoff_id: stored.handoff_id, claiming_agent_id: "bob" });
    expect(trailer(vaultRoot)).toBe("bob");
    store.handoffs.purge(stored.handoff_id, "carol");
    expect(trailer(vaultRoot)).toBe("carol");

    store.submitToInbox("a fact worth filing", { agentId: "dave" });
    expect(subject(vaultRoot)).toMatch(/^inbox: submit /);
    expect(trailer(vaultRoot)).toBe("dave");

    store.vaultFiles.createFile("references/a.md", "# A\n", "eve");
    expect(trailer(vaultRoot)).toBe("eve");
    store.vaultFiles.writeFile("references/a.md", "# A edited\n", {}, "frank");
    expect(trailer(vaultRoot)).toBe("frank");
    store.vaultFiles.renameFile("references/a.md", "references/b.md", "grace");
    expect(trailer(vaultRoot)).toBe("grace");
    const bHash = gitIn(vaultRoot, ["rev-parse", "HEAD"]);
    store.vaultFiles.writeFile("references/b.md", "# B changed\n", {}, "heidi");
    store.vaultFiles.restoreFileVersion("references/b.md", bHash, "ivan");
    expect(subject(vaultRoot)).toMatch(/^vault: restore references/);
    expect(trailer(vaultRoot)).toBe("ivan");
    store.vaultFiles.deleteFile("references/b.md", "judy");
    expect(trailer(vaultRoot)).toBe("judy");

    store.writePrimer("Be concise.", "mallory");
    expect(subject(vaultRoot)).toBe("primer: update");
    expect(trailer(vaultRoot)).toBe("mallory");

    store.writeAddendum("intake", "steer the intake", "niaj");
    expect(subject(vaultRoot)).toBe("curator: addendum intake");
    expect(trailer(vaultRoot)).toBe("niaj");
    store.writeAddendum("intake", "steer harder", "niaj");
    store.rollbackAddendum("intake", "olivia");
    expect(subject(vaultRoot)).toBe("curator: rollback intake");
    expect(trailer(vaultRoot)).toBe("olivia");

    store.writeIntakeExamples("examples v1", "peggy");
    expect(subject(vaultRoot)).toBe("curator: intake-examples update");
    expect(trailer(vaultRoot)).toBe("peggy");
    store.writeIntakeExamples("examples v2", "peggy");
    store.rollbackIntakeExamples("sybil");
    expect(subject(vaultRoot)).toBe("curator: intake-examples rollback");
    expect(trailer(vaultRoot)).toBe("sybil");

    store.close();
  });

  it("stamps updated_by with the last attributed writer, and never fabricates one for an anonymous write", () => {
    const { store, vaultRoot } = freshStore();
    const created = store.createMemory({ agent_id: "alice", title: "M", body: "m" });
    const id = created.memory.id;
    const rel = `memories/${fs.readdirSync(path.join(vaultRoot, "memories"))[0]}`;
    // A fresh memory has a creator (agent_id) but no updated_by yet.
    expect(updatedByOf(vaultRoot, rel)).toBe("");

    store.updateMemory(id, { body: "m2" }, "bob");
    expect(updatedByOf(vaultRoot, rel)).toBe("bob"); // last attributed writer

    // An anonymous (unknown-agent) write commits UNtrailered and does NOT fabricate a
    // false updated_by — the prior known writer stands (git holds the full chain).
    store.updateMemory(id, { body: "m3" });
    expect(trailer(vaultRoot)).toBe("");
    expect(updatedByOf(vaultRoot, rel)).toBe("bob");

    store.close();
  });

  it("project, update and suggestion mutations trailer their acting principals", () => {
    const { store, vaultRoot } = freshStore();
    const project = store.projects.create(projectRecord(), "admin-alice");
    expect(subject(vaultRoot)).toBe("project: create prj_123");
    expect(trailer(vaultRoot)).toBe("admin-alice");

    store.projects.update({ ...project, updated_at: "2026-08-06T13:00:00.000Z" }, "curator-bob");
    expect(subject(vaultRoot)).toBe("project: update prj_123");
    expect(trailer(vaultRoot)).toBe("curator-bob");

    store.projectUpdates.append(projectUpdateRecord(), "curator-carol");
    expect(subject(vaultRoot)).toBe("project-update: append pru_123");
    expect(trailer(vaultRoot)).toBe("curator-carol");

    const suggestion = store.projectSuggestions.create(projectSuggestionRecord(), "curator-dave");
    expect(subject(vaultRoot)).toBe("project-suggestion: create prs_123");
    expect(trailer(vaultRoot)).toBe("curator-dave");

    store.projectSuggestions.update(
      {
        ...suggestion,
        status: "rejected",
        resolved_at: "2026-08-06T13:00:00.000Z",
      },
      "admin-eve",
    );
    expect(subject(vaultRoot)).toBe("project-suggestion: update prs_123");
    expect(trailer(vaultRoot)).toBe("admin-eve");
    store.close();
  });
});

describe("whole-tree sweeps split by 'did this actor cause the bytes' (spec 064 SC 3)", () => {
  it("a whole-vault restore trailers the admin who caused it", async () => {
    const { store, vaultRoot } = freshStore();
    store.createMemory({ agent_id: "alice", title: "One", body: "1" });
    const target = gitIn(vaultRoot, ["rev-parse", "HEAD"]);
    store.createMemory({ agent_id: "alice", title: "Two", body: "2" });

    const result = await store.restoreVaultTo(target, { actorId: "dashboard-admin" });
    expect(result.commit).not.toBeNull();
    // The pre-restore snapshot is untrailered (prior state = other people's bytes); the
    // restore commit itself is TRAILERED with the admin — the most destructive op is
    // never anonymous.
    expect(subject(vaultRoot)).toMatch(/^vault: restore to /);
    expect(trailer(vaultRoot)).toBe("dashboard-admin");

    store.close();
  });

  it("the intake consolidate sweep's whole-tree mop-up is UNtrailered — it cannot stamp a concurrent out-of-band edit with a false name (review finding)", async () => {
    const { store, vaultRoot } = freshStore();
    store.submitToInbox("Sarah now leads the platform team.", { agentId: "alice" });
    // A human edits the vault out-of-band (Obsidian, a second process, no repo lock) and leaves it
    // uncommitted — so it is dirty when the sweep's `git add -A` mop-up runs and gets swept in.
    const humanFile = path.join(vaultRoot, "human-note.md");
    fs.writeFileSync(humanFile, "A note the human wrote by hand.\n");
    const scripted: LlmClient = {
      complete: async () => ({
        content: JSON.stringify({
          action: "create",
          title: "Sarah Chen",
          body: "Sarah Chen leads the platform team.",
          tags: ["person"],
          rationale: "novel",
          confidence: 0.97,
        }),
        model: "scripted",
        usage: null,
      }),
    };
    const summary = await store.runIntakeSweep({ llmClient: scripted });
    expect(summary.consolidated).toBe(1);
    // The mop-up commit is whole-tree (the leftover inbox moves have no path set) and therefore
    // must be UNtrailered: with no lock it can sweep the human's bytes, and trailering it
    // `system-consolidator` would stamp a false name — worse than an honest null (spec 064 §4).
    expect(subject(vaultRoot)).toBe("inbox: consolidate sweep");
    expect(trailer(vaultRoot)).toBe("");
    // The human's swept file lands in exactly that untrailered commit — attributed to no one,
    // never falsely to `system-consolidator`.
    const humanCommitTrailer = execFileSync(
      "git",
      ["log", "-1", "--format=%(trailers:key=Librarian-Actor,valueonly)", "--", "human-note.md"],
      { cwd: vaultRoot, encoding: "utf8" },
    ).trim();
    expect(humanCommitTrailer).toBe("");

    store.close();
  });
});

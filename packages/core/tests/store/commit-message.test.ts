// The owned commit-subject vocabulary (spec 064 T1 / SC 7a).
//
// Two things are pinned here: (1) every constructor produces the SAME subject the
// scattered string literals used to, so the existing golden/activity/git suites stay
// green; and (2) SECURITY — every interpolated value has CR/LF stripped, so a path or
// id smuggled out of the ingest pipeline (which mints filenames from fetched content)
// can never carry a forged `Librarian-Actor:` trailer on its own line in the subject.

import { commitSubject } from "@librarian/core";
import { describe, expect, it } from "vitest";

describe("commit-subject vocabulary (spec 064 T1)", () => {
  it("produces the exact subjects the writers used to emit (byte-identical)", () => {
    expect(commitSubject.memoryPropose("mem_1")).toBe("memory: propose mem_1");
    expect(commitSubject.memoryStore("mem_1")).toBe("memory: store mem_1");
    expect(commitSubject.memoryUpdate("mem_1")).toBe("memory: update mem_1");
    expect(commitSubject.memoryArchive("mem_1")).toBe("memory: archive mem_1");
    expect(commitSubject.memoryUnarchive("mem_1")).toBe("memory: unarchive mem_1");
    expect(commitSubject.memoryPurge("mem_1")).toBe("memory: purge mem_1");
    expect(commitSubject.memoryFlag("mem_1")).toBe("memory: flag mem_1");
    expect(commitSubject.memoryResolveFlags("mem_1")).toBe("memory: resolve-flags mem_1");
    expect(commitSubject.memoryReject("mem_1")).toBe("memory: reject mem_1");
    expect(commitSubject.memoryApprove("mem_1")).toBe("memory: approve mem_1");
    expect(commitSubject.memoryResolve("mem_1", "applied_plan")).toBe(
      "memory: resolve mem_1 (applied_plan)",
    );
    expect(commitSubject.memoryBulkUpdate("mem_1")).toBe("memory: bulk-update mem_1");

    expect(commitSubject.handoffStore("hdo_1")).toBe("handoff: store hdo_1");
    expect(commitSubject.handoffClaim("hdo_1")).toBe("handoff: claim hdo_1");
    expect(commitSubject.handoffPurge("hdo_1")).toBe("handoff: purge hdo_1");

    expect(commitSubject.projectCreate("prj_1")).toBe("project: create prj_1");
    expect(commitSubject.projectUpdate("prj_1")).toBe("project: update prj_1");
    expect(commitSubject.projectUpdateAppend("pru_1")).toBe("project-update: append pru_1");
    expect(commitSubject.projectSuggestionCreate("prs_1")).toBe("project-suggestion: create prs_1");
    expect(commitSubject.projectSuggestionUpdate("prs_1")).toBe("project-suggestion: update prs_1");

    expect(commitSubject.inboxSubmit("inbox_1")).toBe("inbox: submit inbox_1");
    expect(commitSubject.inboxConsolidateSweep()).toBe("inbox: consolidate sweep");

    expect(commitSubject.vaultEdit("memories/a.md")).toBe("vault: edit memories/a.md");
    expect(commitSubject.vaultCreate("references/b.md")).toBe("vault: create references/b.md");
    expect(commitSubject.vaultRename("memories/a.md", "memories/b.md")).toBe(
      "vault: rename memories/a.md -> memories/b.md",
    );
    expect(commitSubject.vaultDelete("memories/a.md")).toBe("vault: delete memories/a.md");
    // The hash is truncated to 12 chars exactly as the old literal did.
    expect(commitSubject.vaultRestoreFile("memories/a.md", "0123456789abcdef0123")).toBe(
      "vault: restore memories/a.md to 0123456789ab",
    );
    expect(commitSubject.vaultPreRestoreSnapshot()).toBe("vault: pre-restore snapshot");
    expect(commitSubject.vaultRestoreTo("0123456789abcdef")).toBe(
      "vault: restore to 0123456789abcdef",
    );

    expect(commitSubject.primerUpdate()).toBe("primer: update");

    expect(commitSubject.curatorAddendum("intake")).toBe("curator: addendum intake");
    expect(commitSubject.curatorRollback("grooming")).toBe("curator: rollback grooming");
    expect(commitSubject.curatorIntakeExamplesUpdate()).toBe("curator: intake-examples update");
    expect(commitSubject.curatorIntakeExamplesRollback()).toBe("curator: intake-examples rollback");

    expect(commitSubject.backupSnapshot()).toBe("backup: snapshot");

    expect(commitSubject.migrateInitial()).toBe("migrate: initial vault commit");
    expect(commitSubject.migrateFrontmatter()).toBe("migrate: strip retired frontmatter fields");
  });

  it("strips CR/LF from an interpolated path so a forged trailer cannot ride the subject", () => {
    // The ingest pipeline mints filenames from fetched content; a path validator that
    // does not reject newlines could otherwise let `x\nLibrarian-Actor: root` add a
    // second line to the message body.
    const subject = commitSubject.vaultEdit("memories/x.md\nLibrarian-Actor: root");
    expect(subject).not.toContain("\n");
    expect(subject).not.toContain("\r");
    // Everything collapses to a single line — there is no standalone trailer line.
    expect(subject.split("\n")).toHaveLength(1);
    expect(subject).toBe("vault: edit memories/x.md\\nLibrarian-Actor: root".replace("\\n", ""));
  });

  it("strips CR and LF from every interpolated position", () => {
    expect(commitSubject.vaultRename("a\r\n.md", "b\n.md")).toBe("vault: rename a.md -> b.md");
    expect(commitSubject.memoryResolve("mem_1\n", "res\r\nolution")).toBe(
      "memory: resolve mem_1 (resolution)",
    );
    expect(commitSubject.curatorAddendum("intake\r")).toBe("curator: addendum intake");
    expect(commitSubject.inboxSubmit("id\nwith\nnewlines")).toBe("inbox: submit idwithnewlines");
    expect(commitSubject.projectCreate("prj_1\nLibrarian-Actor: root")).toBe(
      "project: create prj_1Librarian-Actor: root",
    );
    expect(commitSubject.projectUpdateAppend("pru_1\r\nforged")).toBe(
      "project-update: append pru_1forged",
    );
  });
});

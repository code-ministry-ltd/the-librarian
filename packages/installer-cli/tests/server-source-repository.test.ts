import { describe, expect, it } from "vitest";
import { isCanonicalSourceRemote, redactGitDiagnostics } from "../src/server/source-repository.js";

describe("managed source repository identity", () => {
  const credentials = `${["runtime", "user"].join("-")}:${["runtime", "credential"].join("-")}`;

  it.each([
    "https://github.com/code-ministry-ltd/the-librarian",
    "https://github.com/code-ministry-ltd/the-librarian.git",
    `https://${credentials}@github.com/code-ministry-ltd/the-librarian.git`,
    "ssh://git@github.com/code-ministry-ltd/the-librarian.git",
    "git@github.com:code-ministry-ltd/the-librarian.git",
  ])("accepts the canonical repository through a trusted transport: %s", (remote) => {
    expect(isCanonicalSourceRemote(remote)).toBe(true);
  });

  it.each([
    "http://github.com/code-ministry-ltd/the-librarian.git",
    "git://github.com/code-ministry-ltd/the-librarian.git",
    "ftp://github.com/code-ministry-ltd/the-librarian.git",
    "https://github.com/other-owner/the-librarian.git",
    "https://github.example.com/code-ministry-ltd/the-librarian.git",
    "ssh://root@github.com/code-ministry-ltd/the-librarian.git",
    "git@github.com:other-owner/the-librarian.git",
  ])("rejects an insecure or non-canonical source remote: %s", (remote) => {
    expect(isCanonicalSourceRemote(remote)).toBe(false);
  });

  it("redacts credential-bearing URLs and scp remotes from Git diagnostics", () => {
    const secret = ["runtime", "diagnostic", "credential"].join("-");
    const httpsRemote = `https://worker:${secret}@github.com/code-ministry-ltd/the-librarian.git`;
    const scpRemote = `worker@github.com:code-ministry-ltd/the-librarian.git?token=${secret}`;
    const diagnostic = `fatal: unable to access ${httpsRemote}; fallback ${scpRemote}`;

    const redacted = redactGitDiagnostics(diagnostic);

    expect(redacted).toContain("[redacted-remote]");
    expect(redacted).not.toContain(secret);
    expect(redacted).not.toContain(httpsRemote);
    expect(redacted).not.toContain(scpRemote);
  });
});

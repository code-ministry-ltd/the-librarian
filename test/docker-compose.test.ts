// Docker-compose host-publishing guard.
//
// rc.10 (ADR 0008) shipped a compose where both services were attached only to
// a `internal: true` network. Docker does NOT publish host ports for a container
// whose only network is internal (and an internal network also cuts the
// mcp-server's required egress — curator LLM, GitHub backups), so the agent
// surface (port 3838) silently became unreachable from the host on every compose
// deploy from rc.10 through rc.13. `docker compose config` (syntax only) and the
// in-network smoke test both stayed green, so nothing caught it. This pins the
// invariants that would have.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const compose = fs.readFileSync(path.join(REPO_ROOT, "docker", "docker-compose.yml"), "utf8");

describe("docker-compose host publishing", () => {
  it("declares no `internal: true` network — it would block host publishing + egress", () => {
    const internalLines = compose
      .split("\n")
      .filter((line) => /^\s*internal:\s*true\s*$/.test(line));
    expect(
      internalLines,
      "an `internal: true` docker network has no gateway: Docker won't publish the agent " +
        "port (3838) to the host and the mcp-server loses egress (curator, backups). Keep the " +
        "services on a normal bridge; the tRPC port stays off-host by simply not being published.",
    ).toEqual([]);
  });

  it("publishes the mcp-server agent port (3838) to the host", () => {
    expect(
      /:3838:3838"/.test(compose),
      "the agent surface (/mcp + /healthz + /primer.md) must be published to the host on 3838",
    ).toBe(true);
  });

  it("exposes opt-in operator DNS on every service, with no tailnet default", () => {
    // Both services share the host's egress constraints (the mcp-server makes
    // the curator's LLM calls); unset vars render no `dns:` key, so this is a
    // no-op unless the operator sets LIBRARIAN_DNS(_FALLBACK). The Tailscale
    // resolver must never be the default — it adds latency off a tailnet host.
    const dnsSlots = compose.match(/^\s+- \$\{LIBRARIAN_DNS:-\}$/gm) ?? [];
    expect(dnsSlots, "every service declares the opt-in LIBRARIAN_DNS slot").toHaveLength(2);
    const fallbackSlots = compose.match(/^\s+- \$\{LIBRARIAN_DNS_FALLBACK:-\}$/gm) ?? [];
    expect(fallbackSlots, "every service declares the optional DNS fallback slot").toHaveLength(2);
    expect(compose).not.toContain("100.100.100.100");
  });

  it("never publishes the admin tRPC port (3840) to the host", () => {
    // 3840 appears only as the internal LIBRARIAN_TRPC_PORT env value, never in a
    // host `ports:` mapping (which would read `:3840:3840`). ADR 0008: the admin
    // API — which can return decrypted secrets — stays off the host entirely.
    expect(
      /:3840:3840/.test(compose),
      "the admin tRPC port (3840) must never be published to the host (ADR 0008)",
    ).toBe(false);
  });
});

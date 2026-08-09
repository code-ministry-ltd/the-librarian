import fs from "node:fs";
import { describe, expect, it } from "vitest";

const compose = fs.readFileSync(
  new URL("../../../docker/docker-compose.image.yml", import.meta.url),
  "utf8",
);
const envExample = fs.readFileSync(
  new URL("../../../docker/all-in-one.env.example", import.meta.url),
  "utf8",
);
const ciWorkflow = fs.readFileSync(
  new URL("../../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);

describe("image-only Docker Compose deployment", () => {
  it("runs the published all-in-one image with a latest convenience default", () => {
    expect(compose).toMatch(/^ {2}the-librarian:/m);
    expect(compose).toContain(
      "ghcr.io/code-ministry-ltd/the-librarian:${LIBRARIAN_VERSION:-latest}",
    );
    expect(compose).not.toMatch(/^\s+build:/m);
  });

  it("does not grant Docker or host privileges", () => {
    expect(compose).not.toContain("/var/run/docker.sock");
    expect(compose).not.toMatch(/^\s+privileged:/m);
    expect(compose).not.toMatch(/^\s+network_mode:\s*host/m);
  });

  it("binds both public endpoints to loopback by default", () => {
    expect(compose).toContain(
      "${LIBRARIAN_DASHBOARD_PUBLISHED_HOST:-127.0.0.1}:${LIBRARIAN_DASHBOARD_PORT:-3042}:3000",
    );
    expect(compose).toContain(
      "${LIBRARIAN_MCP_PUBLISHED_HOST:-127.0.0.1}:${LIBRARIAN_MCP_PORT:-3838}:3838",
    );
    expect(compose).not.toContain(":3840");
    expect(compose).not.toContain("LIBRARIAN_TRPC_");
  });

  it("persists /data and supports a named-volume or bind-mount source", () => {
    expect(compose).toContain("${LIBRARIAN_DATA_SOURCE:-librarian_data}:/data");
    expect(compose).toMatch(/^volumes:\n {2}librarian_data:/m);
    expect(compose).toContain("${LIBRARIAN_DATA_UID:-1000}:${LIBRARIAN_DATA_GID:-1000}");
  });

  it("passes secrets through env-file interpolation and restarts unless stopped", () => {
    expect(compose).toContain("LIBRARIAN_AGENT_TOKEN: ${LIBRARIAN_AGENT_TOKEN:?missing}");
    expect(compose).toContain("LIBRARIAN_SECRET_KEY: ${LIBRARIAN_SECRET_KEY:?missing}");
    expect(compose).toMatch(/^\s+restart: unless-stopped$/m);
    expect(envExample).toContain("LIBRARIAN_VERSION=latest");
    expect(envExample).toContain("LIBRARIAN_AGENT_TOKEN=");
    expect(envExample).toContain("LIBRARIAN_SECRET_KEY=");
  });

  it("is rendered by CI without printing its interpolated credentials", () => {
    expect(ciWorkflow).toContain(
      "docker compose --env-file docker/all-in-one.env.example -f docker/docker-compose.image.yml config --quiet",
    );
  });
});

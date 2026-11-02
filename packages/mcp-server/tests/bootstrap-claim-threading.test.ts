import type { AddressInfo } from "node:net";
import {
  createBootstrapClaimHandle,
  createInertBootstrapClaimHandle,
  createLibrarianStore,
} from "@librarian/core";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../test/helpers.js";
import { resolveBootstrapClaimHandle } from "../dist/bootstrap-claim-config.js";
import type { AuthConfig } from "../dist/http/auth.js";
import { type LibrarianServerOptions, createLibrarianServer } from "../dist/librarian-server.js";
import type { LibrarianPlugin } from "../dist/plugin.js";
import { createContextFactory } from "../dist/trpc/context.js";
import { adminProcedure, router } from "../dist/trpc/trpc.js";

const CLAIM_SECRET = "server-bootstrap-claim-secret-".repeat(2);

function internalAuth(): AuthConfig {
  return {
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    host: "127.0.0.1",
    port: 0,
  };
}

function baseOptions(dataDir: string): LibrarianServerOptions {
  return {
    dataDir,
    secretKey: null,
    host: "127.0.0.1",
    port: 0,
    trpcHost: "127.0.0.1",
    trpcPort: 0,
    adminToken: "",
    agentToken: "",
    agentTokenMap: new Map(),
    allowedOrigins: [],
    allowNoAuth: true,
    maxBodyBytes: 1024 * 1024,
    backupTickMs: 0,
    intakePollMs: 0,
    groomingPollMs: 0,
    transcriptSweepTickMs: 0,
  };
}

describe("bootstrap claim boot configuration", () => {
  it("returns an inert handle without consulting the data dir when the env is unset", () => {
    const handle = resolveBootstrapClaimHandle({}, "/path/that/does/not/exist");

    expect(handle.armed).toBe(false);
  });

  it("treats Compose's explicit empty default as dormant", () => {
    const handle = resolveBootstrapClaimHandle(
      { LIBRARIAN_BOOTSTRAP_CLAIM_SECRET: "" },
      "/path/that/does/not/exist",
    );

    expect(handle.armed).toBe(false);
  });

  it("pre-binds an armed handle to the configured data dir", () => {
    const dataDir = makeTempDir();
    try {
      const handle = resolveBootstrapClaimHandle(
        { LIBRARIAN_BOOTSTRAP_CLAIM_SECRET: CLAIM_SECRET },
        dataDir,
      );

      expect(handle.armed).toBe(true);
      expect(handle.isBurned()).toBe(false);
    } finally {
      cleanupTempDir(dataDir);
    }
  });

  it("fails boot validation for a configured secret shorter than 32 characters", () => {
    expect(() =>
      resolveBootstrapClaimHandle({ LIBRARIAN_BOOTSTRAP_CLAIM_SECRET: "too-short" }, "/unused"),
    ).toThrow("LIBRARIAN_BOOTSTRAP_CLAIM_SECRET must be at least 32 characters");
  });
});

describe("bootstrap claim handle threading", () => {
  it("puts the exact armed handle on contexts and defaults direct callers to inert", () => {
    const dataDir = makeTempDir();
    const store = createLibrarianStore({ dataDir });
    const armed = createBootstrapClaimHandle({
      dataDir,
      secret: CLAIM_SECRET,
    });
    const req = { headers: {} };
    try {
      const armedContext = createContextFactory({
        store,
        auth: internalAuth(),
        secretKey: null,
        bootstrapClaim: armed,
      })({ req } as never);
      expect(armedContext.bootstrapClaim).toBe(armed);

      const inertContext = createContextFactory({
        store,
        auth: internalAuth(),
        secretKey: null,
      })({ req } as never);
      expect(inertContext.bootstrapClaim.armed).toBe(false);
    } finally {
      store.close();
      cleanupTempDir(dataDir);
    }
  });

  it("delivers one pre-bound handle through the real server factory and internal listener", async () => {
    const dataDir = makeTempDir();
    const handle = createBootstrapClaimHandle({
      dataDir,
      secret: CLAIM_SECRET,
    });
    const claimProbe = router({
      state: adminProcedure.query(({ ctx }) => ({
        armed: ctx.bootstrapClaim.armed,
        sameHandle: ctx.bootstrapClaim === handle,
      })),
    });
    const plugin: LibrarianPlugin = {
      name: "claimprobe",
      trpcRouters: claimProbe,
    };
    const server = createLibrarianServer({
      ...baseOptions(dataDir),
      bootstrapClaim: handle,
      plugins: [plugin],
    });

    try {
      server.start();
      if (!server.internals.internalServer.listening) {
        await new Promise<void>((resolve) =>
          server.internals.internalServer.once("listening", resolve),
        );
      }
      const port = (server.internals.internalServer.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/trpc/claimprobe.state`);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        result: {
          data: {
            armed: true,
            sameHandle: true,
          },
        },
      });
    } finally {
      await server.stop();
      cleanupTempDir(dataDir);
    }
  });

  it("accepts the shared inert handle as an explicit factory input", () => {
    const dataDir = makeTempDir();
    const server = createLibrarianServer({
      ...baseOptions(dataDir),
      bootstrapClaim: createInertBootstrapClaimHandle(),
    });
    try {
      expect(server.store).toBeDefined();
    } finally {
      server.store.close();
      cleanupTempDir(dataDir);
    }
  });
});

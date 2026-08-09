#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const HEALTH_PROBE = [
  "const urls=['http://127.0.0.1:3000/api/health','http://127.0.0.1:3838/healthz'];",
  "Promise.all(urls.map(url=>fetch(url).then(response=>{if(!response.ok)throw new Error(String(response.status));})))",
  ".then(()=>process.exit(0)).catch(()=>process.exit(1));",
].join("");

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNonEmpty(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function assertContainerName(value) {
  const name = assertNonEmpty(value, "containerName");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
    throw new Error(`containerName contains unsupported characters: ${name}`);
  }
  return name;
}

function redact(value, secrets) {
  return secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), value);
}

/**
 * Start an all-in-one image, prove both co-located services respond, then remove it.
 * The injected runner/sleep/log seams keep the behaviour deterministic in tests.
 */
export async function smokeDockerImage(options) {
  const imageRef = assertNonEmpty(options.imageRef, "imageRef");
  const containerName = assertContainerName(options.containerName);
  const attempts = options.attempts ?? 45;
  const intervalMs = options.intervalMs ?? 2_000;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error("attempts must be a positive integer.");
  }
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error("intervalMs must be a non-negative number.");
  }

  const run = options.run ?? runCommand;
  const sleep = options.sleep ?? delay;
  const log = options.log ?? console.log;
  const agentToken = randomBytes(32).toString("hex");
  const secretKey = randomBytes(32).toString("hex");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "librarian-image-smoke-"));
  const envFile = path.join(tempDir, "deploy.env");
  fs.writeFileSync(
    envFile,
    `LIBRARIAN_AGENT_TOKEN=${agentToken}\nLIBRARIAN_SECRET_KEY=${secretKey}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  fs.chmodSync(envFile, 0o600);

  try {
    const start = await run("docker", [
      "run",
      "-d",
      "--name",
      containerName,
      "--env-file",
      envFile,
      imageRef,
    ]);
    if (start.code !== 0) {
      const detail = redact(start.stderr.trim() || start.stdout.trim(), [agentToken, secretKey]);
      throw new Error(
        `docker run failed (exit ${start.code ?? "signal"})${detail ? `:\n${detail}` : "."}`,
      );
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const probe = await run("docker", ["exec", containerName, "node", "-e", HEALTH_PROBE]);
      if (probe.code === 0) {
        log("both endpoints healthy");
        return;
      }
      if (attempt < attempts - 1) await sleep(intervalMs);
    }

    const logs = await run("docker", ["logs", "--tail", "100", containerName]);
    const detail = redact(logs.stdout.trim() || logs.stderr.trim(), [agentToken, secretKey]);
    throw new Error(
      "image did not make both endpoints healthy" +
        (detail ? `; recent container logs:\n${detail}` : "; no container logs captured"),
    );
  } finally {
    await run("docker", ["rm", "-f", containerName]).catch(() => undefined);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const imageRef = process.argv[2];
  const containerName =
    process.env.LIBRARIAN_SMOKE_CONTAINER_NAME ?? `librarian-image-smoke-${process.pid}`;
  smokeDockerImage({ imageRef, containerName }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

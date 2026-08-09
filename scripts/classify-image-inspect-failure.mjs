#!/usr/bin/env node

import fs from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Return true only when Buildx reports that this exact image manifest is absent.
 * Every other failure is indeterminate and must fail closed.
 */
export function isMissingImageError(output, versionRef) {
  const message = output.trim();
  if (/manifest unknown|no such manifest/i.test(message)) return true;
  return message === `ERROR: ${versionRef}: not found`;
}

function main([statusFile, versionRef]) {
  if (!statusFile || !versionRef) return 1;

  try {
    return isMissingImageError(fs.readFileSync(statusFile, "utf8"), versionRef) ? 0 : 1;
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}

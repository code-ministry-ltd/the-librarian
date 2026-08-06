import fs from "node:fs";
import path from "node:path";
import { UnsafeVaultPathError, type Vault } from "../corpus/vault.js";

/** Refuse direct project-store access through any symlink beneath the scoped vault root. */
export function assertSafeProjectStorePath(vault: Vault, relPath: string): void {
  const absolute = path.resolve(vault.root, relPath);
  const relative = path.relative(vault.root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new UnsafeVaultPathError(relPath);
  }
  let current = vault.root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new UnsafeVaultPathError(relPath);
  }
}

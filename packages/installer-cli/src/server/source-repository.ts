import { redactSecrets } from "./redact.js";

export const CANONICAL_SOURCE_REPOSITORY = "https://github.com/code-ministry-ltd/the-librarian";

const CANONICAL_PATH = "/code-ministry-ltd/the-librarian";

/** Accept the canonical repository only over authenticated, encrypted transports. */
export function isCanonicalSourceRemote(remote: string): boolean {
  const value = remote.trim();
  const scp = value.match(/^git@github\.com:(\/?[^?#]+)$/iu);
  if (scp) return normalizePath(scp[1] ?? "") === CANONICAL_PATH;

  try {
    const parsed = new URL(value);
    if (parsed.hostname.toLowerCase() !== "github.com" || parsed.search || parsed.hash)
      return false;
    if (normalizePath(parsed.pathname) !== CANONICAL_PATH) return false;
    if (parsed.protocol === "https:") return parsed.port === "" || parsed.port === "443";
    return (
      parsed.protocol === "ssh:" &&
      parsed.username === "git" &&
      parsed.password === "" &&
      (parsed.port === "" || parsed.port === "22")
    );
  } catch {
    return false;
  }
}

/** Git may echo credential-bearing remote URLs; no Git diagnostic is trusted. */
export function redactGitDiagnostics(text: string): string {
  return redactSecrets(text)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"`]+/giu, "[redacted-remote]")
    .replace(/\b[^\s/@:]+@[^\s/'":]+(?::|\/)[^\s'"`]+/gu, "[redacted-remote]");
}

function normalizePath(value: string): string {
  const withLeadingSlash = value.startsWith("/") ? value : `/${value}`;
  return withLeadingSlash
    .replace(/\/$/u, "")
    .replace(/\.git$/iu, "")
    .toLowerCase();
}

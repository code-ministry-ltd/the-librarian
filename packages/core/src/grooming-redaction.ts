// Secret redaction for curator evidence (memory-curator spec §9).
//
// Evidence gathered for a curation run (memory bodies, file paths, metadata)
// is scrubbed of secret-looking material
// BEFORE prompt construction — the spec is emphatic that catching secrets at
// output-validation time is too late, since the value would already have been
// sent to the LLM.
//
// This is a conservative, KNOWN-FORMAT redactor: PEM private keys, well-known
// provider token shapes, JWTs, basic-auth URLs, and `key = secret` assignments.
// It deliberately does NOT do generic high-entropy detection — that would nuke
// legitimate content (git SHAs, UUIDs, content hashes) and degrade the curator's
// evidence. Entropy/semantic detection is a v2 concern. Better to miss an exotic
// custom secret than to shred every long identifier; the high-signal patterns
// below cover the overwhelming majority of real leaks.
//
// Known v1 limitation: an UNQUOTED secret value containing spaces (e.g. an
// un-quoted multi-word passphrase) is only redacted up to the first space.
// Quoted multi-word values are redacted in full. Real secrets in configs / env /
// JSON are quoted or single-token, so this is an accepted v1 gap.
//
// Server-only; no external dependencies (pure string transforms).

type Replacer = string | ((match: string, ...groups: string[]) => string);

interface RedactionRule {
  name: string;
  pattern: RegExp;
  replacement: Replacer;
}

// `[A-Za-z0-9_-]` etc. are spelled out per rule. Order matters: the assignment
// rule runs first so an assigned secret is redacted as a single unit, and its
// marker (`[REDACTED:secret]`) is skipped on any later pass via the
// `(?!\[REDACTED)` guards below — so re-running is a true no-op (count included).
const ASSIGNMENT_KEYWORDS =
  "passwords?|passwd|api[_-]?keys?|access[_-]?keys?|secret[_-]?keys?|account[_-]?keys?|" +
  "client[_-]?secrets?|auth[_-]?tokens?|secrets?|tokens?|credentials?";

const RULES: readonly RedactionRule[] = [
  {
    // `api_key = …`, `PASSWORD: "…"`, `MY_SECRET_KEY='…'`. Keeps the key +
    // separator for context; redacts only the value. Quoted values (single or
    // double) are redacted in full (spaces allowed); unquoted values up to the
    // first space (3+ chars, to avoid nuking tiny prose like "token: no").
    name: "secret-assignment",
    pattern: new RegExp(
      `\\b([\\w-]*(?:${ASSIGNMENT_KEYWORDS}))(\\s*[:=]\\s*)` +
        `(?:"(?!\\[REDACTED)[^"\\n]+"|'(?!\\[REDACTED)[^'\\n]+'|(?!\\[REDACTED)[^\\s"']{3,})`,
      "gi",
    ),
    replacement: (match, key, sep) => {
      const valueStart = key.length + sep.length;
      const value = match.slice(valueStart);
      const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";
      return `${key}${sep}${quote}[REDACTED:secret]${quote}`;
    },
  },
  {
    name: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-key]",
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?![A-Za-z0-9._-])/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    // Basic-auth credentials in URLs / connection strings:
    // `scheme://user:pass@host`. Keeps scheme + username, redacts the password.
    name: "url-credential",
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):([^\s:/@]+)@/gi,
    replacement: "$1:[REDACTED:url-credential]@",
  },
  {
    name: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws-key]",
  },
  {
    name: "github-token",
    pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g,
    replacement: "[REDACTED:github-token]",
  },
  {
    name: "gitlab-token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED:gitlab-token]",
  },
  {
    name: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35,}\b/g,
    replacement: "[REDACTED:google-key]",
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[0-9A-Za-z]+(?:-[0-9A-Za-z]+){1,4}/g,
    replacement: "[REDACTED:slack-token]",
  },
  {
    name: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{36,}\b/g,
    replacement: "[REDACTED:npm-token]",
  },
  {
    name: "pypi-token",
    pattern: /\bpypi-[A-Za-z0-9_-]{16,}\b/g,
    replacement: "[REDACTED:pypi-token]",
  },
  {
    // Stripe live/test keys (underscore-separated; distinct from sk- below).
    name: "stripe-key",
    pattern: /\b[rsp]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replacement: "[REDACTED:stripe-key]",
  },
  {
    // OpenAI / Anthropic style: `sk-…` and `sk-ant-…`.
    name: "api-key",
    pattern: /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED:api-key]",
  },
  {
    name: "bearer-token",
    pattern: /\bBearer\s+(?!\[REDACTED)[A-Za-z0-9._~+/-]{8,}=*/g,
    replacement: "Bearer [REDACTED:bearer]",
  },
];

export interface RedactionResult {
  /** The input with secret-looking material replaced by `[REDACTED:…]` markers. */
  redacted: string;
  /** How many secrets were redacted (sum across all rules). */
  count: number;
}

export interface RedactionOffsetMapResult extends RedactionResult {
  /** Source UTF-16 offset for each output code unit; redaction output is null-mapped. */
  sourceOffsetByOutputIndex: (number | null)[];
}

interface InternalRedactionResult extends RedactionResult {
  sourceOffsetByOutputIndex?: (number | null)[];
}

function appendSourceRange(
  textParts: string[],
  targetMap: (number | null)[] | undefined,
  sourceText: string,
  sourceMap: (number | null)[] | undefined,
  start: number,
  end: number,
): void {
  textParts.push(sourceText.slice(start, end));
  if (!targetMap || !sourceMap) return;
  for (let index = start; index < end; index++) targetMap.push(sourceMap[index] ?? null);
}

function appendUnmappedReplacement(
  textParts: string[],
  targetMap: (number | null)[] | undefined,
  replacement: string,
): void {
  textParts.push(replacement);
  if (!targetMap) return;
  for (let index = 0; index < replacement.length; index++) targetMap.push(null);
}

function redactSecretsInternal(text: string, includeSourceMap: boolean): InternalRedactionResult {
  let redacted = text;
  let sourceOffsetByOutputIndex: (number | null)[] | undefined = includeSourceMap
    ? Array.from({ length: text.length }, (_, index) => index)
    : undefined;
  let count = 0;

  for (const rule of RULES) {
    const matcher = new RegExp(rule.pattern.source, rule.pattern.flags);
    let cursor = 0;
    const nextText: string[] = [];
    const nextMap: (number | null)[] | undefined = sourceOffsetByOutputIndex ? [] : undefined;
    let matched = false;

    for (const match of redacted.matchAll(matcher)) {
      const start = match.index;
      if (start === undefined) continue;
      matched = true;
      appendSourceRange(nextText, nextMap, redacted, sourceOffsetByOutputIndex, cursor, start);
      const replacement =
        typeof rule.replacement === "function"
          ? rule.replacement(match[0], ...(match.slice(1) as string[]))
          : match[0].replace(new RegExp(rule.pattern.source, rule.pattern.flags), rule.replacement);
      appendUnmappedReplacement(nextText, nextMap, replacement);
      cursor = start + match[0].length;
      count++;
    }

    if (matched) {
      appendSourceRange(
        nextText,
        nextMap,
        redacted,
        sourceOffsetByOutputIndex,
        cursor,
        redacted.length,
      );
      redacted = nextText.join("");
      if (nextMap !== undefined) sourceOffsetByOutputIndex = nextMap;
    }
  }

  return sourceOffsetByOutputIndex === undefined
    ? { redacted, count }
    : { redacted, count, sourceOffsetByOutputIndex };
}

/**
 * Redact secret-looking material and preserve a conservative map back to the
 * source. Every character produced by a replacement is unmapped, so callers
 * cannot mistake a redaction marker for source text.
 */
export function redactSecretsWithSourceMap(text: string): RedactionOffsetMapResult {
  const result = redactSecretsInternal(text, true);
  if (result.sourceOffsetByOutputIndex === undefined) {
    throw new Error("Internal redaction error: requested source map was not produced.");
  }
  return {
    redacted: result.redacted,
    count: result.count,
    sourceOffsetByOutputIndex: result.sourceOffsetByOutputIndex,
  };
}

/**
 * Redact secret-looking material from a single string. Pure and idempotent:
 * re-running over already-redacted text finds nothing new and returns count 0
 * (markers are skipped by every rule).
 */
export function redactSecrets(text: string): RedactionResult {
  const { redacted, count } = redactSecretsInternal(text, false);
  return { redacted, count };
}

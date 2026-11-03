// The logs the Logs page shows (spec 081), in tab order. The server owns the data
// (`logs.page` / `logs.export` in the mcp-server tRPC router); this table owns only how each
// source is named and explained, and where its richer, purpose-built view lives.

export const LOG_SOURCE_IDS = [
  "reads",
  "refusals",
  "captures",
  "intake",
  "curation",
  "backups",
  "vault",
] as const;

export type LogSourceId = (typeof LOG_SOURCE_IDS)[number];

export interface LogSourceInfo {
  id: LogSourceId;
  label: string;
  description: string;
  /** A page with a richer view of the same records, when there is one. */
  fullView?: { href: string; label: string };
}

export const LOG_SOURCES: readonly LogSourceInfo[] = [
  {
    id: "reads",
    label: "Reads",
    description:
      "What agents asked the Librarian for and what came back: every recall and reference search, " +
      "and the primer and journal each new session receives. Off until you turn it on.",
  },
  {
    id: "refusals",
    label: "Refusals",
    description:
      "Requests the server turned away: bad or missing tokens, blocked origins, rate limits, " +
      "failed sign-ins and writes to shelves the caller can't write to.",
  },
  {
    id: "captures",
    label: "Captures",
    description: "References sent in from the browser extension or your phone, and how each went.",
    fullView: { href: "/settings/ingest", label: "Captures" },
  },
  {
    id: "intake",
    label: "Intake runs",
    description:
      "Each time the curator filed captured conversations into memories. The download includes " +
      "every decision it made and why.",
    fullView: { href: "/curator", label: "Curator" },
  },
  {
    id: "curation",
    label: "Curation runs",
    description:
      "Each time the curator tidied existing memories: merges, edits, archives. The download " +
      "includes every decision it made and why.",
    fullView: { href: "/curator", label: "Curator" },
  },
  {
    id: "backups",
    label: "Backups",
    description: "Each push of the vault to its backup remote.",
    fullView: { href: "/settings/backups", label: "Backups" },
  },
  {
    id: "vault",
    label: "Vault history",
    description:
      "Every change to the vault, from its git history: who or what changed which files, and when.",
    fullView: { href: "/activity", label: "Vault activity" },
  },
];

export function isLogSourceId(value: unknown): value is LogSourceId {
  return typeof value === "string" && (LOG_SOURCE_IDS as readonly string[]).includes(value);
}

/** The download's file name: `librarian-reads-2026-11-03.ndjson`. */
export function downloadFileName(source: LogSourceId, now: Date = new Date()): string {
  return `librarian-${source}-${now.toISOString().slice(0, 10)}.ndjson`;
}

/** One JSON object per line, newline-terminated; an empty log is an empty file. */
export function toNdjson(rows: readonly unknown[]): string {
  return rows.length === 0 ? "" : `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

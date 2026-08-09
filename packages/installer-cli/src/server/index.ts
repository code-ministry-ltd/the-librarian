// The `librarian server` command group — self-host the Librarian from the CLI.
//
// `server` with no subcommand prints the lifecycle surface; `librarian --help`
// reveals this group alongside the harness commands (wired in `runtime.ts`).

/** The `server` subcommands, in the order they appear in the surface (§4). */
export const SERVER_SUBCOMMANDS = [
  "up",
  "update",
  "down",
  "status",
  "logs",
  "enable-boot",
  "disable-boot",
  "autoupdate",
  "admin",
] as const;

export type ServerSubcommand = (typeof SERVER_SUBCOMMANDS)[number];

/** The `librarian server` command surface (spec §4). */
export function serverUsage(): string {
  return [
    "Usage: librarian server <subcommand> [flags]",
    "",
    "Self-host the Librarian server from an exact published release,",
    "or use --ref <development-ref>; source refs build locally,",
    "then hand its MCP URL + agent token to `librarian install` on clients.",
    "",
    "Subcommands:",
    "  up            Pull an exact release (or build a source ref) and start it",
    "  update        Prepare, verify and replace; recover the old image on failure",
    "  down          Stop the container (the data volume is preserved)",
    "  status        Running? healthy? deployed version vs latest release",
    "  logs          Tail the container logs ([-f] [--service mcp|dashboard|all])",
    "  enable-boot   Start the server on boot (Linux systemd; macOS deferred)",
    "  disable-boot  Reverse enable-boot",
    "  autoupdate    Schedule auto-updates on the host (enable|disable|uninstall|status)",
    "  admin         Run an admin command in the container (backup|restore|auth|rebuild)",
    "",
    "Run `librarian server <subcommand> --help` for flags (per subcommand).",
  ].join("\n");
}

/** True iff `name` is one of the known `server` subcommands. */
export function isServerSubcommand(name: string): name is ServerSubcommand {
  return (SERVER_SUBCOMMANDS as readonly string[]).includes(name);
}

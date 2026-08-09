// The `librarian server` command group — self-host the Librarian from the CLI.
//
// S1 lays the foundation the later slices build on: the command SURFACE (the
// help table from spec §4), the `docker.ts` seam, and server preflights. The
// individual subcommands (up / update / down / status / logs / enable-boot /
// disable-boot / admin) are implemented in their own slices; here they resolve
// to a clear "arrives in a later slice" notice so the surface is honest about
// what exists today.
//
// `server` with NO subcommand prints the surface; `librarian --help` reveals
// this group alongside the harness commands (wired in `runtime.ts`).

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
    "Self-host the Librarian server (build + run the all-in-one container),",
    "then hand its MCP URL + agent token to `librarian install` on clients.",
    "",
    "Subcommands:",
    "  up            Build + run the server; print the MCP URL + agent token",
    "  update        Re-pin to a release, rebuild, recreate (data volume kept)",
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

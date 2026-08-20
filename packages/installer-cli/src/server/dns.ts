// Opt-in operator DNS for `librarian server up` / `update`.
//
// Docker DNS is a *runtime* setting (`docker create --dns`), not a container
// env var — so it cannot live in deploy.env. Nameservers are persisted in
// non-secret deploy-state and emitted from `buildRunArgs`. Compose already has
// LIBRARIAN_DNS (PR #461); this module is the CLI equivalent.
//
// c-ares never consults a later nameserver after NXDOMAIN, so primary must
// come first. MagicDNS forwards public lookups, so a single Tailscale resolver
// (`100.100.100.100`) usually suffices. Unset → Docker's default resolv.conf.

import { isIP } from "node:net";
import type { FlagValue } from "../parse-args.js";

export class DnsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DnsConfigError";
  }
}

export type DnsOption = { kind: "unset" } | { kind: "set"; value: string } | { kind: "clear" };

export interface DnsConfig {
  dns?: string | undefined;
  dnsFallback?: string | undefined;
}

/** Parse `--dns` / `--dns-fallback` / `--no-dns` / `--no-dns-fallback`. */
export function parseDnsFlag(
  value: FlagValue | undefined,
  flag: "--dns" | "--dns-fallback",
): DnsOption {
  if (value === undefined) return { kind: "unset" };
  if (value === false) return { kind: "clear" };
  if (value === true) {
    throw new DnsConfigError(`${flag} requires an IPv4 address (e.g. ${flag} 100.100.100.100).`);
  }
  if (Array.isArray(value)) {
    throw new DnsConfigError(`Pass ${flag} once — repeated values are not a DNS list.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return { kind: "clear" };
  return { kind: "set", value: validateNameserver(trimmed, flag) };
}

export function dnsFlagsSpecified(dns: DnsOption, dnsFallback: DnsOption): boolean {
  return dns.kind !== "unset" || dnsFallback.kind !== "unset";
}

/**
 * Merge flags onto stored deploy-state. `--no-dns` clears both; `--no-dns-fallback`
 * clears only the fallback. A fallback with no primary is a teaching error.
 */
export function resolveDnsConfig(input: {
  dns: DnsOption;
  dnsFallback: DnsOption;
  stored?: DnsConfig | undefined;
}): DnsConfig {
  let dns = input.stored?.dns;
  let dnsFallback = input.stored?.dnsFallback;
  if (input.dns.kind === "set") dns = input.dns.value;
  if (input.dns.kind === "clear") {
    dns = undefined;
    dnsFallback = undefined;
  }
  if (input.dnsFallback.kind === "set") dnsFallback = input.dnsFallback.value;
  if (input.dnsFallback.kind === "clear") dnsFallback = undefined;
  if (dnsFallback && !dns) {
    throw new DnsConfigError(
      "--dns-fallback requires a primary nameserver. Pass --dns <ipv4> as well, or drop --dns-fallback.",
    );
  }
  if (dns) validateNameserver(dns, "--dns");
  if (dnsFallback) validateNameserver(dnsFallback, "--dns-fallback");
  return { dns, dnsFallback };
}

export function nameserverTuple(config: DnsConfig): string[] {
  const servers: string[] = [];
  if (config.dns) servers.push(config.dns);
  if (config.dnsFallback) servers.push(config.dnsFallback);
  return servers;
}

export function dnsConfigFromServers(servers: string[]): DnsConfig {
  return {
    ...(servers[0] ? { dns: servers[0] } : {}),
    ...(servers[1] ? { dnsFallback: servers[1] } : {}),
  };
}

export function sameNameservers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** Docker `HostConfig.Dns` is a string array, null, or absent. */
export function parseLiveDns(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

/**
 * Replacement nameservers: flags or stored state win; otherwise keep whatever
 * the live container already has (so a manual `--dns` stopgap survives a
 * version-bump recreate and gets adopted into deploy-state).
 */
export function dnsServersForReplacement(input: {
  flagsSpecified: boolean;
  resolved: DnsConfig;
  live: string[];
}): string[] {
  if (input.flagsSpecified || input.resolved.dns) return nameserverTuple(input.resolved);
  return input.live;
}

/**
 * Same-version no-op may skip DNS when the operator has neither flags nor stored
 * DNS (a live hand-patch must not force a recreate). Flags or stored DNS must
 * match both live and state before we no-op.
 */
export function dnsAllowsNoOp(input: {
  flagsSpecified: boolean;
  stored: string[];
  live: string[];
  desired: string[];
}): boolean {
  if (input.flagsSpecified) {
    return (
      sameNameservers(input.desired, input.live) && sameNameservers(input.desired, input.stored)
    );
  }
  if (input.stored.length > 0) return sameNameservers(input.stored, input.live);
  return true;
}

function validateNameserver(value: string, flag: "--dns" | "--dns-fallback"): string {
  const kind = isIP(value);
  if (kind === 4) return value;
  if (kind === 6) {
    throw new DnsConfigError(
      `IPv6 nameservers are not supported yet (got '${value}' for ${flag}). Use an IPv4 address (e.g. 100.100.100.100).`,
    );
  }
  throw new DnsConfigError(
    `Invalid ${flag} '${value}': expected an IPv4 address (e.g. 100.100.100.100).`,
  );
}

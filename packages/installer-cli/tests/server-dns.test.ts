import { describe, expect, it } from "vitest";
import {
  DnsConfigError,
  dnsAllowsNoOp,
  dnsConfigFromServers,
  dnsFlagsSpecified,
  dnsServersForReplacement,
  nameserverTuple,
  parseDnsFlag,
  parseLiveDns,
  resolveDnsConfig,
  sameNameservers,
} from "../src/server/dns.js";
import { parseArgs } from "../src/parse-args.js";

describe("parseDnsFlag — --dns / --no-dns", () => {
  it("treats an omitted flag as unset", () => {
    expect(parseDnsFlag(undefined, "--dns")).toEqual({ kind: "unset" });
  });

  it("reads --dns <ipv4> from parseArgs", () => {
    const { flags } = parseArgs(["--dns", "100.100.100.100"]);
    expect(parseDnsFlag(flags.dns, "--dns")).toEqual({
      kind: "set",
      value: "100.100.100.100",
    });
  });

  it("treats --no-dns as clear", () => {
    const { flags } = parseArgs(["--no-dns"]);
    expect(parseDnsFlag(flags.dns, "--dns")).toEqual({ kind: "clear" });
  });

  it("a bare --dns without an address is a teaching error", () => {
    const { flags } = parseArgs(["--dns"]);
    expect(() => parseDnsFlag(flags.dns, "--dns")).toThrow(DnsConfigError);
    expect(() => parseDnsFlag(flags.dns, "--dns")).toThrow(/requires an IPv4 address/i);
  });

  it("a hostname is a teaching error that names the input", () => {
    expect(() => parseDnsFlag("marvin.akita-betelgeuse.ts.net", "--dns")).toThrow(
      /Invalid --dns 'marvin\.akita-betelgeuse\.ts\.net'/,
    );
  });

  it("an IPv6 nameserver is a teaching error", () => {
    expect(() => parseDnsFlag("::1", "--dns")).toThrow(/IPv6 nameservers are not supported/);
  });
});

describe("resolveDnsConfig", () => {
  it("omitted flags keep stored nameservers", () => {
    expect(
      resolveDnsConfig({
        dns: { kind: "unset" },
        dnsFallback: { kind: "unset" },
        stored: { dns: "100.100.100.100", dnsFallback: "8.8.8.8" },
      }),
    ).toEqual({ dns: "100.100.100.100", dnsFallback: "8.8.8.8" });
  });

  it("--no-dns clears primary and fallback", () => {
    expect(
      resolveDnsConfig({
        dns: { kind: "clear" },
        dnsFallback: { kind: "unset" },
        stored: { dns: "100.100.100.100", dnsFallback: "8.8.8.8" },
      }),
    ).toEqual({ dns: undefined, dnsFallback: undefined });
  });

  it("--dns-fallback without a primary is a teaching error", () => {
    expect(() =>
      resolveDnsConfig({
        dns: { kind: "unset" },
        dnsFallback: { kind: "set", value: "8.8.8.8" },
      }),
    ).toThrow(/--dns-fallback requires a primary nameserver/);
  });

  it("flagsSpecified is false when both flags are omitted", () => {
    expect(dnsFlagsSpecified({ kind: "unset" }, { kind: "unset" })).toBe(false);
    expect(dnsFlagsSpecified({ kind: "set", value: "1.1.1.1" }, { kind: "unset" })).toBe(true);
  });
});

describe("replacement nameservers", () => {
  it("flags or stored state win over live HostConfig.Dns", () => {
    expect(
      dnsServersForReplacement({
        flagsSpecified: true,
        resolved: { dns: "100.100.100.100" },
        live: ["8.8.8.8"],
      }),
    ).toEqual(["100.100.100.100"]);
  });

  it("with no flags and no stored primary, a recreate keeps live DNS", () => {
    expect(
      dnsServersForReplacement({
        flagsSpecified: false,
        resolved: {},
        live: ["100.100.100.100"],
      }),
    ).toEqual(["100.100.100.100"]);
  });

  it("round-trips a two-server list through state fields", () => {
    const servers = ["100.100.100.100", "8.8.8.8"];
    expect(nameserverTuple(dnsConfigFromServers(servers))).toEqual(servers);
    expect(sameNameservers(servers, ["100.100.100.100", "8.8.8.8"])).toBe(true);
    expect(sameNameservers(servers, ["8.8.8.8", "100.100.100.100"])).toBe(false);
  });

  it("parses Docker HostConfig.Dns arrays and treats null/garbage as unset", () => {
    expect(parseLiveDns(["100.100.100.100", "8.8.8.8"])).toEqual(["100.100.100.100", "8.8.8.8"]);
    expect(parseLiveDns(null)).toEqual([]);
    expect(parseLiveDns(["", 1, "1.1.1.1"])).toEqual(["1.1.1.1"]);
  });

  it("same-version no-op ignores a live hand-patch when nothing is stored or flagged", () => {
    expect(
      dnsAllowsNoOp({
        flagsSpecified: false,
        stored: [],
        live: ["100.100.100.100"],
        desired: ["100.100.100.100"],
      }),
    ).toBe(true);
  });

  it("same-version --dns still recreates when state has not recorded the nameserver", () => {
    expect(
      dnsAllowsNoOp({
        flagsSpecified: true,
        stored: [],
        live: [],
        desired: ["100.100.100.100"],
      }),
    ).toBe(false);
  });
});

// DNS-rebinding guard for the dashboard (review 2026-09-29 item #2).
//
// With authentication "open", the dashboard and its /api/trpc proxy grant admin to
// anyone who can reach them. A web page on evil.example can rebind its name to this
// machine; the browser then treats the dashboard as same-origin, but it still sends
// `Host: evil.example`, and a page can never choose that header. So in open mode,
// refuse any Host a rebinding attacker could produce: a public DNS name the operator
// did not list. Mirrors `isAllowedHost` in the mcp-server (packages/mcp-server/src/
// http/auth.ts); this copy has no Node imports so it runs in edge middleware.
//
// Always allowed: IP literals, `localhost`, local-only names (`.localhost`, `.local`,
// `.lan`, `.internal`, `.home.arpa`), and single-label names
// (a docker-compose service), none of which public DNS can stand in for. Also the
// names in LIBRARIAN_ALLOWED_HOSTS and the hosts of LIBRARIAN_PUBLIC_URL / AUTH_URL.

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
// Names only a local resolver answers (mDNS, the LAN router, reserved special-use
// domains), so a rebinding attacker's public DNS can never serve them.
const LOCAL_SUFFIXES = [".localhost", ".local", ".lan", ".internal", ".home.arpa"];

type Env = Record<string, string | undefined>;

function hostnameOf(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function listedHostnames(env: Env): Set<string> {
  const names = new Set<string>();
  for (const host of (env.LIBRARIAN_ALLOWED_HOSTS ?? "").split(",")) {
    const trimmed = host.trim().toLowerCase();
    if (trimmed) names.add(trimmed);
  }
  for (const url of [env.LIBRARIAN_PUBLIC_URL, env.AUTH_URL, env.NEXTAUTH_URL]) {
    if (!url) continue;
    try {
      names.add(new URL(url).hostname.toLowerCase());
    } catch {
      // Not a URL; nothing to add.
    }
  }
  return names;
}

/** Is `hostHeader` a name no DNS-rebinding page could have produced? */
export function isAllowedHost(hostHeader: string | null, env: Env = process.env): boolean {
  if (!hostHeader) return true; // no Host header: not a browser
  const hostname = hostnameOf(hostHeader);
  if (hostname === null) return false;
  if (hostname.startsWith("[") || IPV4.test(hostname)) return true;
  if (hostname === "localhost" || LOCAL_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }
  if (!hostname.includes(".")) return true;
  return listedHostnames(env).has(hostname);
}

export function hostRefusalMessage(hostHeader: string | null): string {
  return (
    `Host '${hostHeader ?? ""}' is not allowed while dashboard authentication is off. ` +
    "This refuses DNS-rebinding requests from web pages. If you reach the dashboard by " +
    "that name, add it to LIBRARIAN_ALLOWED_HOSTS (comma-separated), or turn on authentication."
  );
}

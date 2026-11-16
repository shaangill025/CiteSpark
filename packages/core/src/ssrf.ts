import { isIP } from "node:net";

/** ENR-03: addresses a web fetcher must never connect to. */

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

function parseIPv6(input: string): number[] | null {
  let ip = input;
  const zone = ip.indexOf("%");
  if (zone >= 0) ip = ip.slice(0, zone);
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIPv4(tail);
    if (!v4) return null;
    const hi = ((v4[0] ?? 0) << 8) | (v4[1] ?? 0);
    const lo = ((v4[2] ?? 0) << 8) | (v4[3] ?? 0);
    ip = `${ip.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const groups: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      groups.push(parseInt(g, 16));
    }
    return groups;
  };
  const head = toGroups(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const rest = toGroups(halves[1] ?? "");
  if (!rest) return null;
  const fill = 8 - head.length - rest.length;
  if (fill < 1) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...rest];
}

function blockedIPv4(o: readonly number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  return (
    a === 0 || // "this" network
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT, includes 100.100.100.200 metadata
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata 169.254.169.254
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments, 192.0.0.192
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

function embeddedV4(g: readonly number[], at: number): number[] {
  const x = g[at] ?? 0;
  const y = g[at + 1] ?? 0;
  return [x >> 8, x & 255, y >> 8, y & 255];
}

function blockedIPv6(g: readonly number[]): boolean {
  const first5Zero = g.slice(0, 5).every((x) => x === 0);
  if (first5Zero && g[5] === 0xffff) return blockedIPv4(embeddedV4(g, 6)); // IPv4-mapped
  if (first5Zero && g[5] === 0) return true; // ::, ::1 and deprecated IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) {
    return blockedIPv4(embeddedV4(g, 6)); // NAT64
  }
  if (g[0] === 0x2002) return blockedIPv4(embeddedV4(g, 1)); // 6to4
  // Only global unicast 2000::/3 may pass; carve out special-purpose ranges inside it.
  if (((g[0] ?? 0) & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && ((g[1] ?? 0) < 0x200 || g[1] === 0xdb8)) return true; // 2001::/23 (Teredo etc.), documentation
  if (g[0] === 0x3fff && ((g[1] ?? 0) & 0xf000) === 0) return true; // documentation 3fff::/20
  return false;
}

/** True when `ip` is not a publicly routable unicast address, or is not an IP literal at all. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const o = parseIPv4(ip);
    return o === null || blockedIPv4(o);
  }
  if (family === 6) {
    const g = parseIPv6(ip);
    return g === null || blockedIPv6(g);
  }
  return true;
}

export type UrlRejection = "scheme" | "credentials" | "host" | "invalid";

/** Parse and screen a URL before any DNS lookup. Only http(s) without credentials passes. */
export function screenUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; reason: UrlRejection } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, reason: "scheme" };
  if (url.username !== "" || url.password !== "") return { ok: false, reason: "credentials" };
  const host = bareHostname(url);
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    return { ok: false, reason: "host" };
  }
  return { ok: true, url };
}

/** Hostname without IPv6 brackets or a trailing root dot. */
export function bareHostname(url: URL): string {
  let h = url.hostname.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h.endsWith(".")) h = h.slice(0, -1);
  return h;
}

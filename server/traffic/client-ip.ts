// Client IP, step 2 of docs/server-map.md §3 (S-1C.1, DAN-790; contract
// Ductus#1836 c.6900102277, confirmed c.6900175554). X-Forwarded-For counts
// only when the direct peer is a trusted proxy from TRUSTED_PROXIES; it is
// walked from the right and the first address that is not trusted is the
// client. Forwarded, X-Real-IP and the like are never read. Addresses are
// compared as numbers (32 or 128 bits), never as text, and an IPv4-mapped
// IPv6 address is the IPv4 address everywhere. Nothing here throws on input
// from the network, and no value from it is ever logged.
import type { IncomingMessage } from "node:http";
import { isIPv6 } from "node:net";

type Ip = { readonly v: 4 | 6; readonly n: bigint };
type Range = { readonly v: 4 | 6; readonly net: bigint; readonly mask: bigint };
/** Parsed TRUSTED_PROXIES; empty means the headers are never read. */
export type TrustedProxies = readonly Range[];

export const NO_TRUSTED_PROXIES: TrustedProxies = Object.freeze([]);
/** Entries of X-Forwarded-For walked at most; past it the nearest trusted hop wins. */
export const MAX_FORWARDED_HOPS = 32;
export const MAX_TRUSTED_PROXIES = 64;
/** The longest valid entry, "[" + 45 + "]:65535"; anything longer is refused unread. */
const MAX_ENTRY_LENGTH = 53;
/** A trusted range may not be broader than this (adversarial pass on DAN-790). */
const MIN_PREFIX = { 4: 8n, 6: 16n } as const;

const BITS = { 4: 32n, 6: 128n } as const;
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4_RE = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`, "u");
const IPV6_CHARS_RE = /^[\da-fA-F:.]{2,45}$/u;
const GROUP_RE = /^[\da-fA-F]{1,4}$/u;
const PORT_RE = /^[1-9]\d{0,4}$/u;
const PREFIX_RE = /^[1-9]\d{0,2}$/u;
const MAPPED = 0xffffn;

function ipv4(text: string): bigint | null {
  if (!IPV4_RE.test(text)) return null;
  return text.split(".").reduce((acc, octet) => (acc << 8n) | BigInt(octet), 0n);
}

function groups(part: string): bigint[] | null {
  if (part === "") return [];
  const out: bigint[] = [];
  const pieces = part.split(":");
  for (const [i, piece] of pieces.entries()) {
    if (i === pieces.length - 1 && piece.includes(".")) {
      const tail = ipv4(piece);
      if (tail === null) return null;
      out.push(tail >> 16n, tail & 0xffffn);
    } else if (GROUP_RE.test(piece)) {
      out.push(BigInt(`0x${piece}`));
    } else {
      return null;
    }
  }
  return out;
}

function ipv6(text: string): bigint | null {
  if (!IPV6_CHARS_RE.test(text) || !isIPv6(text)) return null;
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array<bigint>(missing).fill(0n), ...tail];
  return all.reduce((acc, group) => (acc << 16n) | group, 0n);
}

/** A bare address; an IPv4-mapped IPv6 address becomes IPv4. */
function parseIp(text: string): Ip | null {
  const four = ipv4(text);
  if (four !== null) return { v: 4, n: four };
  const six = ipv6(text);
  if (six === null) return null;
  return six >> 32n === MAPPED ? { v: 4, n: six & 0xffffffffn } : { v: 6, n: six };
}

const validPort = (port: string): boolean => PORT_RE.test(port) && Number(port) <= 65_535;

const blank = (c: string | undefined): boolean => c === " " || c === "\t";

/** Strips spaces and tabs around an entry in linear time (a regex was quadratic). */
function trimOws(raw: string): string {
  let start = 0;
  let end = raw.length;
  while (start < end && blank(raw[start])) start += 1;
  while (end > start && blank(raw[end - 1])) end -= 1;
  return raw.slice(start, end);
}

/** One X-Forwarded-For entry: ip, IPv4:port, [IPv6] or [IPv6]:port. */
function parseEntry(raw: string): Ip | null {
  const entry = trimOws(raw);
  if (entry.length > MAX_ENTRY_LENGTH) return null;
  if (entry.startsWith("[")) {
    const close = entry.indexOf("]");
    const rest = entry.slice(close + 1);
    if (close < 0 || (rest !== "" && !(rest.startsWith(":") && validPort(rest.slice(1))))) {
      return null;
    }
    const ip = parseIp(entry.slice(1, close));
    return ip !== null && ipv4(entry.slice(1, close)) === null ? ip : null;
  }
  const colon = entry.indexOf(":");
  if (colon >= 0 && colon === entry.lastIndexOf(":")) {
    const port = entry.slice(colon + 1);
    const four = ipv4(entry.slice(0, colon));
    return four !== null && validPort(port) ? { v: 4, n: four } : null;
  }
  return parseIp(entry);
}

/** IPv4 dotted, IPv6 in RFC 5952 form (lower case, longest zero run compressed). */
function format(ip: Ip): string {
  if (ip.v === 4) return [24n, 16n, 8n, 0n].map((s) => String((ip.n >> s) & 0xffn)).join(".");
  const words = [112n, 96n, 80n, 64n, 48n, 32n, 16n, 0n].map((s) => Number((ip.n >> s) & 0xffffn));
  let best = -1;
  let bestLength = 1;
  for (let i = 0; i < 8;) {
    let j = i;
    while (j < 8 && words[j] === 0) j += 1;
    if (j - i > bestLength) [best, bestLength] = [i, j - i];
    i = j === i ? i + 1 : j;
  }
  const hex = words.map((w) => w.toString(16));
  if (best < 0) return hex.join(":");
  return `${hex.slice(0, best).join(":")}::${hex.slice(best + bestLength).join(":")}`;
}

function contains(ranges: TrustedProxies, ip: Ip): boolean {
  return ranges.some((range) => range.v === ip.v && (ip.n & range.mask) === range.net);
}

function parseRange(entry: string): Range | null {
  const slash = entry.indexOf("/");
  const ip = parseIp(slash < 0 ? entry : entry.slice(0, slash));
  if (ip === null) return null;
  const mapped = ip.v === 4 && ipv4(slash < 0 ? entry : entry.slice(0, slash)) === null;
  let prefix = BITS[ip.v];
  if (slash >= 0) {
    const text = entry.slice(slash + 1);
    if (!PREFIX_RE.test(text)) return null;
    prefix = BigInt(text) - (mapped ? 96n : 0n);
    if (prefix < MIN_PREFIX[ip.v] || prefix > BITS[ip.v]) return null;
  }
  const all = (1n << BITS[ip.v]) - 1n;
  const mask = all ^ ((1n << (BITS[ip.v] - prefix)) - 1n);
  return (ip.n & mask) === ip.n ? Object.freeze({ v: ip.v, net: ip.n, mask }) : null;
}

/**
 * TRUSTED_PROXIES: addresses and CIDR ranges separated by commas. Unset or
 * blank is the empty list; null means the value is unusable (the server
 * refuses to start): a bad entry, an empty entry, a range broader than /8
 * (IPv4) or /16 (IPv6), host bits set, or more than MAX_TRUSTED_PROXIES
 * entries.
 */
export function parseTrustedProxies(text: string | undefined): TrustedProxies | null {
  if (text === undefined || text.trim() === "") return NO_TRUSTED_PROXIES;
  const entries = text.split(",").map((entry) => entry.trim());
  if (entries.length > MAX_TRUSTED_PROXIES) return null;
  const ranges: Range[] = [];
  for (const entry of entries) {
    const range = parseRange(entry);
    if (range === null) return null;
    ranges.push(range);
  }
  return Object.freeze(ranges);
}

/** The direct peer as the socket reports it; a zone index is local and dropped. */
function parseRemote(remote: string | undefined): Ip | null {
  if (typeof remote !== "string") return null;
  const zone = remote.indexOf("%");
  return parseIp(zone < 0 ? remote : remote.slice(0, zone));
}

type Forwarded = string | readonly string[] | undefined;

/**
 * The client IP by the contract's rules; null only when the socket has no
 * address. readForwarded is called only once the peer is a trusted proxy, so
 * the header is never read otherwise (Codex CLI review on DAN-790).
 */
function resolve(
  remote: string | undefined,
  readForwarded: () => Forwarded,
  trusted: TrustedProxies,
): string | null {
  const direct = parseRemote(remote);
  if (direct === null) return null;
  if (trusted.length === 0 || !contains(trusted, direct)) return format(direct);
  const forwarded = readForwarded();
  if (forwarded === undefined) return format(direct);
  const header = typeof forwarded === "string" ? forwarded : forwarded.join(",");
  let nearest = direct;
  let end = header.length;
  for (let hop = 0; hop < MAX_FORWARDED_HOPS && end >= 0; hop += 1) {
    const start = header.lastIndexOf(",", end - 1);
    const ip = parseEntry(header.slice(start + 1, end));
    if (ip === null) return format(nearest);
    if (!contains(trusted, ip)) return format(ip);
    nearest = ip;
    end = start;
  }
  return format(nearest);
}

/** resolve() for a header value already in hand (tests and property checks). */
export function resolveClientIp(
  remote: string | undefined,
  forwarded: Forwarded,
  trusted: TrustedProxies,
): string | null {
  return resolve(remote, () => forwarded, trusted);
}

const RESOLVED = new WeakMap<IncomingMessage, string | null>();

/** The client IP the clientIp layer recorded; null before it ran or without an address. */
export function clientIpOf(request: IncomingMessage): string | null {
  return RESOLVED.get(request) ?? null;
}

/** Step 2: records the client IP and always lets the request through. */
export function clientIpLayer(trusted: TrustedProxies) {
  return async (request: IncomingMessage): Promise<"next"> => {
    let ip: string | null = null;
    try {
      ip = resolve(
        request.socket?.remoteAddress,
        () => request.headers["x-forwarded-for"],
        trusted,
      );
    } catch {
      ip = null;
    }
    RESOLVED.set(request, ip);
    return "next";
  };
}

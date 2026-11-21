/**
 * The guard of the one outbound path of the tool layer (Ductus
 * docs/contracts/ai-tools-v1.md, "Odlazni dohvat"; plan #1664 S3-N1 to
 * S3-N4).
 *
 * `search(destinationId, query)` is the only way from a tool to the network,
 * and the tool layer has no function that takes an address. The destination
 * is an id the server picks from its own list (the faculty setting,
 * `config/faculties`), never one the model names; for the pilot the list is
 * empty (OC-2), so every call fails before any connection. The query goes
 * only as an encoded parameter of the fixed endpoint: a query that looks like
 * an address, an IP literal or an IDN is only query text.
 *
 * The guard checks, in this order: a known destination; an `https` endpoint
 * to a host name; every resolved address is public (a private, local,
 * link-local or otherwise special address fails, also for a listed
 * destination); then one GET to the vetted address with redirects not
 * followed (a 3xx fails) and the body bounded before it is read whole.
 *
 * No socket is opened here: the transport is handed in. The production
 * composition hands in none (`NO_TRANSPORT`), so even a listed destination
 * would fail; a real transport waits for an owner decision on OC-2.
 */
import { BlockList, isIP } from "node:net";

import { isSearchEndpoint, utf8ByteLength, type SearchDestination } from "../../domain/index.ts";

/** The largest body read from a destination, before any result bound (S3-I1). */
export const FETCH_MAX_BYTES = 64 * 1024;

export type SearchTransport = {
  /** The addresses of a host name; no connection to the destination. */
  resolve(hostname: string): Promise<readonly string[]>;
  /**
   * One GET of `url` to the already vetted `address` (the host name stays in
   * TLS and Host), redirects never followed, at most `maxBytes` of the body
   * read and decoded as UTF-8: `overflow` is true when the body was longer.
   */
  get(request: {
    readonly url: string;
    readonly address: string;
    readonly maxBytes: number;
  }): Promise<{
    readonly status: number;
    readonly text: string;
    readonly overflow: boolean;
  }>;
};

export const SEARCH_FAIL_RULES = Object.freeze([
  "unknown_destination",
  "invalid_endpoint",
  "no_transport",
  "resolve_failed",
  "private_address",
  "redirect",
  "status",
  "too_large",
  "transport_error",
] as const);
export type SearchFailRule = (typeof SEARCH_FAIL_RULES)[number];

export type SearchOutcome =
  | { readonly kind: "result"; readonly text: string }
  | { readonly kind: "failed"; readonly rule: SearchFailRule };

export type SearchGuard = {
  /** The ids the server may pick from; empty in the pilot. */
  readonly destinationIds: readonly string[];
  search(destinationId: string, query: string): Promise<SearchOutcome>;
};

const BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["::", 96],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const) {
  BLOCKED.addSubnet(network, prefix, "ipv6");
}

/** The IPv4 address inside an IPv4-mapped IPv6 address, or null. */
function mappedIpv4(address: string): string | null {
  const match = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (match) return match[1] ?? null;
  const hex = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(address);
  if (!hex) return null;
  const high = parseInt(hex[1] ?? "0", 16);
  const low = parseInt(hex[2] ?? "0", 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

/**
 * True for an address the guard may connect to: a valid IPv4 or IPv6
 * literal outside every private, loopback, link-local, shared, documentation,
 * multicast and reserved range. Anything else, including a host name, is not.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !BLOCKED.check(address, "ipv4");
  if (family !== 6) return false;
  const v4 = mappedIpv4(address);
  if (v4 !== null) return isIP(v4) === 4 && !BLOCKED.check(v4, "ipv4");
  if (/^::ffff:/i.test(address)) return false;
  return !BLOCKED.check(address, "ipv6");
}

/** The transport of the production composition: there is none (OC-2). */
export const NO_TRANSPORT: SearchTransport | null = null;

function failed(rule: SearchFailRule): SearchOutcome {
  return Object.freeze({ kind: "failed", rule });
}

/**
 * A guard over a destination list and a transport. A destination with an
 * endpoint the domain does not accept is left out of the list, so the guard
 * never holds one.
 */
export function createSearchGuard(input: {
  readonly destinations: readonly SearchDestination[];
  readonly transport: SearchTransport | null;
  readonly maxBytes?: number;
}): SearchGuard {
  const byId = new Map<string, SearchDestination>();
  for (const destination of input.destinations) {
    if (isSearchEndpoint(destination.endpoint) && !byId.has(destination.id))
      byId.set(destination.id, destination);
  }
  const maxBytes = input.maxBytes ?? FETCH_MAX_BYTES;
  const transport = input.transport;
  return Object.freeze({
    destinationIds: Object.freeze([...byId.keys()]),
    async search(destinationId: string, query: string): Promise<SearchOutcome> {
      const destination = byId.get(destinationId);
      if (destination === undefined) return failed("unknown_destination");
      if (!isSearchEndpoint(destination.endpoint)) return failed("invalid_endpoint");
      if (transport === null) return failed("no_transport");
      const url = new URL(destination.endpoint);
      // The query only ever goes as one encoded parameter (S3-N2).
      url.searchParams.set(destination.queryParameter, query);
      let addresses: readonly string[];
      try {
        addresses = await transport.resolve(url.hostname);
      } catch {
        return failed("resolve_failed");
      }
      if (addresses.length === 0) return failed("resolve_failed");
      // Every address must be public; one private answer fails the whole call.
      if (!addresses.every(isPublicAddress)) return failed("private_address");
      try {
        const response = await transport.get({
          url: url.href,
          address: addresses[0]!,
          maxBytes,
        });
        if (response.status >= 300 && response.status < 400) return failed("redirect");
        if (response.status !== 200) return failed("status");
        if (response.overflow || utf8ByteLength(response.text) > maxBytes)
          return failed("too_large");
        return Object.freeze({ kind: "result", text: response.text });
      } catch {
        return failed("transport_error");
      }
    },
  });
}

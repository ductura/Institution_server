// Step 3 of the request flow (docs/server-map.md §3): the networks operator
// paths may be reached from (S-1C.2, DAN-832-1; contract Ductus#1836). Pure
// rules; the layer that refuses lives in http. An empty list restricts nothing.
import { type IpRange, inRanges, parseRange } from "./client-ip.ts";

/** A list only parseAllowedNetworks makes; any other array allows nothing. */
export type AllowedNetworks = readonly IpRange[];

export const MAX_ALLOWED_NETWORKS = 16;
/** The longest string value of a setting (Value in server/contracts/routes/settings.ts). */
export const MAX_ALLOWED_NETWORKS_LENGTH = 256;

const PARSED = new WeakSet<AllowedNetworks>();
const seal = (networks: IpRange[]): AllowedNetworks => {
  const sealed = Object.freeze(networks);
  PARSED.add(sealed);
  return sealed;
};

export const NO_ALLOWED_NETWORKS: AllowedNetworks = seal([]);

// Only what an address, a range and the separators need: no tab, CR, LF,
// NBSP, DEL, zone id, bracket or port reaches parseRange.
const CHARS_RE = /^[\dA-Fa-f:./, ]*$/u;

/**
 * Addresses and CIDR ranges separated by commas, with only spaces around an
 * entry, under the limits of TRUSTED_PROXIES (no host bits, nothing broader
 * than /8 or /16). Blank is the empty list; null means unusable: not a
 * string, a character outside the list above, an empty or bad entry, more
 * than MAX_ALLOWED_NETWORKS entries or MAX_ALLOWED_NETWORKS_LENGTH characters.
 */
export function parseAllowedNetworks(text: unknown): AllowedNetworks | null {
  if (typeof text !== "string" || text.length > MAX_ALLOWED_NETWORKS_LENGTH) return null;
  if (!CHARS_RE.test(text)) return null;
  if (text.trim() === "") return NO_ALLOWED_NETWORKS;
  const entries = text.split(",");
  if (entries.length > MAX_ALLOWED_NETWORKS) return null;
  const networks: IpRange[] = [];
  for (const entry of entries) {
    const range = parseRange(entry.trim());
    if (range === null) return null;
    networks.push(range);
  }
  return seal(networks);
}

/**
 * May a client IP (as clientIpOf writes it, null for none) reach an operator
 * path? The empty list allows everyone; otherwise only an address inside it.
 */
export function networkAllows(networks: AllowedNetworks, ip: string | null): boolean {
  if (!PARSED.has(networks)) return false;
  if (networks.length === 0) return true;
  return typeof ip === "string" && inRanges(networks, ip);
}

const ABSOLUTE_RE = /^[a-z][a-z\d+.-]*:\/\/[^/?#]*/iu;
const OPS = "/api/v1/ops";

/**
 * Is a request target an operator path: /api/v1/ops or below it? Broader than
 * the router, which matches a path exactly: the scheme and host of an
 * absolute target are dropped, case is ignored and runs of slashes count as
 * one, so a refusal here can only be a path the router would not serve.
 */
export function isOpsPath(target: string | undefined): boolean {
  if (typeof target !== "string") return false;
  const path = target
    .replace(ABSOLUTE_RE, "")
    .split(/[?#]/u, 1)[0]
    ?.toLowerCase()
    .replace(/\/+/gu, "/");
  return path === OPS || path?.startsWith(`${OPS}/`) === true;
}

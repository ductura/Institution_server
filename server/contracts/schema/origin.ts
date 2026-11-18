import { Type } from "@sinclair/typebox";

// The Origin header as a checked subset of the WHATWG URL (DAN-930-1d-a,
// decision Ductus#2028 c.6982431631): whatever the schema accepts is an
// http(s) origin that new URL(v).origin gives back unchanged. Not every such
// origin is accepted: no label may begin with xn-- (the pilot's host is
// ASCII), and an IPv6 host is [::1] or eight groups with no two zero groups
// side by side. The server still compares the value with its own origin
// (originLayer, pipeline step 7). A lookahead, not $, ends the pattern, as in
// live.ts, so an engine where $ also matches before a final newline reads it
// the same. A step counter for the pattern comes in DAN-930-1d-a2.
const END = "(?![\\s\\S])";
// The code points WHATWG keeps in a domain, dots and empty labels included.
const DOMAIN = "[-!\"$&'()*+,.0-9;=_`a-z{}~]+";
// A last label (before one trailing dot) that is a number makes the host IPv4.
const NUMBER_LAST = `(?:[^:]*\\.)?(?:[0-9]+|0x[0-9a-f]*)\\.?(?::|${END})`;
// Any label beginning with xn--; XN-- never gets this far, as DOMAIN has no capitals.
const PUNYCODE = "(?:[^:]*\\.)?xn--";
const OCTET = "(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])";
const GROUP = "(?:0|[1-9a-f][0-9a-f]{0,3})";
const ZEROS = "(?:[^\\]]*:)?0:0(?::|\\])";
const IPV6 = `\\[(?:::1|(?!${ZEROS})(?:${GROUP}:){7}${GROUP})\\]`;
const HOST = `(?:(?:${OCTET}\\.){3}${OCTET}|(?!${NUMBER_LAST}|${PUNYCODE})${DOMAIN}|${IPV6})`;
const PORT =
  "(?:0|[1-9][0-9]{0,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])";
const port = (fallback: string) => `(?::(?!${fallback}${END})${PORT})?`;

/** The longest value accepted: Node's limit for all request headers together. */
export const ORIGIN_MAX_LENGTH = 16384;

/** A canonical http(s) origin, as the client sends it in the Origin header. */
export const Origin = Type.String({
  maxLength: ORIGIN_MAX_LENGTH,
  pattern: `^(?:https://${HOST}${port("443")}|http://${HOST}${port("80")})${END}`,
});

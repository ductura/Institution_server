// Interface text hidden in a `data:` URL (S-1L.2c, DAN-784). A literal such as
// `"DATA:text/plain;base64,xI1la2Fq"` or `"da\tta:,%C4%8Dekaj"` is "čekaj" to
// `fetch`, a browser or any other WHATWG URL parser. The scheme is found the
// way that parser finds it, and every check reads the one normalized input
// that normalizeUrlInput gives (review FAILs c.6896676607 and c.6896957758 on
// ductura/server#64). The body is then decoded (percent and base64) and each
// decoded text is handed back to the caller, which judges it as text.
import { Buffer } from "node:buffer";

/** The input of a URL as the WHATWG URL parser reads it, and its ASCII-lowercase twin. */
export type UrlInput = {
  /** The input with no leading or trailing C0 control or space and no tab, CR or LF. */
  readonly input: string;
  /** `input` with ASCII upper case letters lowered; same length, same indices. */
  readonly folded: string;
};

// WHATWG URL "basic URL parser": strip leading and trailing C0 control or
// space, then remove all ASCII tab or newline; the scheme is ASCII-lowercased.
/** The one normalization of a URL input; every data: URL check reads its result. */
export function normalizeUrlInput(text: string): UrlInput {
  const input = text.replace(/^[\u0000- ]+|[\u0000- ]+$/gu, "").replace(/[\t\n\r]/gu, "");
  const folded = input.replace(/[A-Z]/gu, (c) => c.toLowerCase());
  return { input, folded };
}

const SCHEME_CHAR = /[a-z0-9+.-]/u;
// A data: URL nested in a decoded body, or a body percent-encoded again,
// is read up to this many times.
const MAX_DEPTH = 8;

// `%XX` becomes the byte XX; every other character is its UTF-8 bytes, as the
// URL parser percent-encodes them before the body is percent-decoded.
function percentDecode(text: string): Uint8Array {
  const bytes = Buffer.from(text, "utf8");
  const out: number[] = [];
  const hex = (b: number | undefined): boolean =>
    b !== undefined && /[0-9a-fA-F]/u.test(String.fromCharCode(b));
  for (let i = 0; i < bytes.length; i += 1) {
    const b = bytes[i] ?? 0;
    if (b === 0x25 && hex(bytes[i + 1]) && hex(bytes[i + 2])) {
      out.push(Number.parseInt(Buffer.from(bytes.subarray(i + 1, i + 3)).toString("latin1"), 16));
      i += 2;
    } else out.push(b);
  }
  return Uint8Array.from(out);
}

// WHATWG "forgiving-base64 decode": ASCII whitespace is removed, padding is
// optional. The URL-safe alphabet is accepted too (stricter than fetch).
function forgivingBase64(text: string): Uint8Array | null {
  let data = text.replace(/[\t\n\f\r ]/gu, "");
  if (data.length % 4 === 0) data = data.replace(/={1,2}$/u, "");
  if (data.length % 4 === 1 || !/^[A-Za-z0-9+/_-]*$/u.test(data)) return null;
  return Uint8Array.from(Buffer.from(data, "base64"));
}

// The texts bytes can be read as: UTF-8 (what `Response.text()` gives), the
// charset the media type names, and Latin-1 when the bytes are not UTF-8 (so a
// legacy single-byte charset never hides a letter as U+FFFD).
function bytesToTexts(bytes: Uint8Array, mime: string): string[] {
  const texts: string[] = [];
  try {
    texts.push(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    texts.push(Buffer.from(bytes).toString("latin1"));
  }
  const charset = /;\s*charset\s*=\s*"?([^";]+)/u.exec(mime)?.[1]?.trim();
  if (charset) {
    try {
      texts.push(new TextDecoder(charset).decode(bytes));
    } catch {
      // An unknown label: fetch falls back to UTF-8, read above.
    }
  }
  return texts;
}

// Escapes a body keeps for its reader: JSON and JS `\\uXXXX` (a surrogate pair
// written as two escapes is one character), `\\u{…}`, `\\xXX`, and HTML
// character references. A named reference other than the markup ones is read
// as a letter: the rule keeps no entity table, and `&ccaron;` is "č".
const JS_ESCAPE = /\\u\{([0-9a-fA-F]{1,6})\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/gu;
const ENTITY = /&#(?:([0-9]{1,7})|[xX]([0-9a-fA-F]{1,6}));?|&([A-Za-z][A-Za-z0-9]*);/gu;
const MARKUP_ENTITIES = new Set(["amp", "lt", "gt", "quot", "apos", "nbsp"]);
const codeText = (code: number): string =>
  code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
function unescapeText(text: string): string {
  return text
    .replace(JS_ESCAPE, (_, braced?: string, unit?: string, byte?: string) =>
      braced === undefined
        ? String.fromCharCode(Number.parseInt(unit ?? byte ?? "0", 16))
        : codeText(Number.parseInt(braced, 16)),
    )
    .replace(ENTITY, (_ref, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return MARKUP_ENTITIES.has(name) ? " " : "\u0161";
      return codeText(dec === undefined ? Number.parseInt(hex ?? "0", 16) : Number(dec));
    });
}

// A decoded text, and every text it gives when percent-decoded or unescaped
// again or when it holds a data: URL itself.
// Each text is read once (`out` is a set), so the layers stay few.
function layers(text: string, mime: string, depth: number, out: Set<string>): void {
  if (out.has(text)) return;
  out.add(text);
  if (depth >= MAX_DEPTH) return;
  const next = /%[0-9a-fA-F]{2}/u.test(text) ? bytesToTexts(percentDecode(text), mime) : [];
  next.push(unescapeText(text));
  for (const t of new Set(next)) if (t !== text) layers(t, mime, depth + 1, out);
  collect(text, depth + 1, out);
}

function collect(text: string, depth: number, out: Set<string>): void {
  if (depth > MAX_DEPTH) return;
  const { input, folded } = normalizeUrlInput(text);
  // Wherever `data:` starts a scheme: at the start, or after a character no
  // scheme holds (an attribute quote, a space, a control).
  for (let at = folded.indexOf("data:"); at !== -1; at = folded.indexOf("data:", at + 1)) {
    if (at > 0 && SCHEME_CHAR.test(folded[at - 1] ?? "")) continue;
    const start = at + "data:".length;
    // The fragment is no part of the body (fetch, "data: URL processor").
    const hash = input.indexOf("#", start);
    const end = hash === -1 ? input.length : hash;
    const comma = input.indexOf(",", start);
    if (comma === -1 || comma > end) continue;
    const mime = folded.slice(start, comma);
    const body = percentDecode(input.slice(comma + 1, end));
    // The base64 flag is also read after percent-decoding the media type.
    const decodedMime = Buffer.from(percentDecode(mime)).toString("latin1");
    const base64 = [mime, decodedMime].some((m) => /;\s*base64\s*$/u.test(m));
    const parts = [body];
    if (base64) {
      const bytes = forgivingBase64(Buffer.from(body).toString("latin1"));
      if (bytes) parts.push(bytes);
    }
    for (const bytes of parts)
      for (const decoded of bytesToTexts(bytes, decodedMime))
        layers(decoded, decodedMime, depth, out);
  }
}

/** Every text the data: URLs in `text` decode to; empty when it holds none. */
export function dataUrlTexts(text: string): string[] {
  const out = new Set<string>();
  collect(text, 0, out);
  return [...out];
}

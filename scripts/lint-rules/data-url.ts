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
  // A loop, not a regex: `[…]+$` is quadratic on a long run of spaces (QA on DAN-784).
  const c0 = (i: number): boolean => text.charCodeAt(i) <= 0x20;
  let start = 0;
  let end = text.length;
  while (start < end && c0(start)) start += 1;
  while (end > start && c0(end - 1)) end -= 1;
  const input = text.slice(start, end).replace(/[\t\n\r]/gu, "");
  return { input, folded: asciiLower(input) };
}

const asciiLower = (text: string): string => text.replace(/[A-Z]/gu, (c) => c.toLowerCase());
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
// charset the media type names, and Latin-1 when a text body is not UTF-8 (so
// a legacy single-byte charset never hides a letter as U+FFFD).
function bytesToTexts(bytes: Uint8Array, mime: string): string[] {
  // Lenient UTF-8 as `Response.text()` reads it: one bad byte does not hide
  // the letters after it (QA on DAN-784: `%80%D7%90`).
  const texts = [new TextDecoder("utf-8").decode(bytes)];
  // Latin-1 only for text (a binary image is no interface text).
  const textual = /^\s*(?:text\/|;|$)/u.test(mime);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    if (textual) texts.push(Buffer.from(bytes).toString("latin1"));
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
// Digit runs are read whole: `&#00000269;` and `\u{0010D}` are "č" (Codex P2 on #82).
const JS_ESCAPE = /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/gu;
const ENTITY = /&#(?:([0-9]+)|[xX]([0-9a-fA-F]+));?|&([A-Za-z][A-Za-z0-9]*);/gu;
const MARKUP_ENTITIES = new Set([
  ...["amp", "lt", "gt", "quot", "apos", "nbsp", "copy", "reg", "trade", "mdash", "ndash"],
  ...["hellip", "laquo", "raquo", "bull", "middot", "times", "divide", "deg", "euro", "shy"],
]);
const codeText = (code: number): string =>
  code <= 0x10ffff ? String.fromCodePoint(code) : "\uFFFD";
// HTML "numeric character reference end state": 0x80–0x9F is read as
// windows-1252 (`&#154;` is "š", review FAIL c.6904968268 on #82); the
// others in that range stay as they are.
const WINDOWS_1252: Readonly<Record<number, number>> = {
  ...{ 0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020 },
  ...{ 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152 },
  ...{ 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022 },
  ...{ 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a },
  ...{ 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178 },
};
/** The character an HTML numeric reference gives (WHATWG HTML, 13.2.5.80). */
export function htmlReferenceText(code: number): string {
  // NUL, a surrogate and a code point past U+10FFFF become U+FFFD.
  if (code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff) return "\uFFFD";
  return String.fromCodePoint(WINDOWS_1252[code] ?? code);
}
function unescapeText(text: string): string {
  return text
    .replace(JS_ESCAPE, (_, braced?: string, unit?: string, byte?: string) =>
      braced === undefined
        ? String.fromCharCode(Number.parseInt(unit ?? byte ?? "0", 16))
        : codeText(Number.parseInt(braced, 16)),
    )
    .replace(ENTITY, (_ref, dec?: string, hex?: string, name?: string) => {
      if (name !== undefined) return MARKUP_ENTITIES.has(name) ? " " : "\u0161";
      return htmlReferenceText(dec === undefined ? Number.parseInt(hex ?? "0", 16) : Number(dec));
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
    // The URL runs to the end of the text, or, inside markup, CSS or a
    // sentence, up to the first character after the comma that ends it there
    // (Codex P2 on #82: `<iframe src="data:;base64,…"></iframe>`). A quote
    // before the comma is a media type parameter (`charset="utf-8"`), no end
    // (review FAIL c.6904446769). A space ends it only in the last cut, since
    // base64 may hold spaces inside a quoted attribute.
    const url = input.slice(at);
    const comma = url.indexOf(",");
    const ends = [/["'`<>]/u, /["'`<>)\s]/u];
    const cut = (end: RegExp): string => {
      const stop = comma === -1 ? -1 : url.slice(comma + 1).search(end);
      return stop === -1 ? url : url.slice(0, comma + 1 + stop);
    };
    const urls = new Set([url, ...ends.map(cut)]);
    for (const candidate of urls) {
      // The raw text after `data:`, and the URL as the parser serializes it,
      // which drops dot segments (`/a,b/../`) and so may move the first comma.
      const rests = [candidate.slice("data:".length)];
      try {
        const href = new URL(candidate).href;
        if (href.startsWith("data:")) rests.push(href.slice("data:".length));
      } catch {
        // No URL to the parser: the raw text is still read.
      }
      for (const rest of rests) readBody(rest, depth, out);
    }
  }
}

// The media type and body of a data: URL after `data:`, decoded.
function readBody(rest: string, depth: number, out: Set<string>): void {
  // The fragment is no part of the body (fetch, "data: URL processor").
  const hash = rest.indexOf("#");
  const end = hash === -1 ? rest.length : hash;
  const comma = rest.indexOf(",");
  if (comma === -1 || comma > end) return;
  const mime = asciiLower(rest.slice(0, comma));
  const body = percentDecode(rest.slice(comma + 1, end));
  // The base64 flag is also read after percent-decoding the media type, and
  // that text goes through the same normalization (`%42ase64` is `;Base64`,
  // review FAIL c.6904446769).
  const decodedMime = normalizeUrlInput(Buffer.from(percentDecode(mime)).toString("latin1")).folded;
  const base64 = [mime, decodedMime].some((m) => /;\s*base64\s*$/u.test(m));
  const parts = [body];
  if (base64) {
    // The whole body, and its longest base64 prefix: text after the URL that
    // no cut removed (markup, a closing quote) cannot hide the letters.
    const text = Buffer.from(body).toString("latin1");
    const prefix = /^[A-Za-z0-9+/_=\t\n\f\r -]*/u.exec(text)?.[0] ?? "";
    for (const candidate of new Set([text, prefix, prefix.slice(0, -1)])) {
      const bytes = forgivingBase64(candidate);
      if (bytes) parts.push(bytes);
    }
  }
  for (const bytes of parts)
    for (const decoded of bytesToTexts(bytes, decodedMime))
      layers(decoded, decodedMime, depth, out);
}

/** Every text the data: URLs in `text` decode to; empty when it holds none. */
export function dataUrlTexts(text: string): string[] {
  const out = new Set<string>();
  collect(text, 0, out);
  return [...out];
}

// Interface text hidden in a `data:` URL (S-1L.2c, DAN-784). A literal such as
// `"DATA:text/plain;base64,xI1la2Fq"` or `"da\tta:,%C4%8Dekaj"` is "čekaj" to
// `fetch`, a browser or any other WHATWG URL parser. The scheme is found the
// way that parser finds it, and every check reads the one normalized input
// that normalizeUrlInput gives (review FAILs c.6896676607 and c.6896957758 on
// ductura/server#64). The body is then decoded (percent and base64).
//
// Fail closed (DAN-784 after the cut of ductura/server#82): HTML character
// references are never decoded. A body whose type reads references (HTML,
// XML, WebVTT) or whose type is missing or unclear is suspect as soon as a
// decoded text holds `&` before a letter or `#`. A URL too long, too deeply
// encoded or decoding to too many texts is suspect too: the rule reports
// what it cannot read instead of guessing.
import { Buffer } from "node:buffer";

/** The input of a URL as the WHATWG URL parser reads it, and its ASCII-lowercase twin. */
export type UrlInput = {
  /** The input with no leading or trailing C0 control or space and no tab, CR or LF. */
  readonly input: string;
  /** `input` with ASCII upper case letters lowered; same length, same indices. */
  readonly folded: string;
};

/** What the data: URLs in a text decode to. */
export type DataUrlFindings = {
  /** Every decoded text, judged by the caller as interface text. */
  readonly texts: readonly string[];
  /** Why the rule reports without judging: a reference it does not decode, or a limit. */
  readonly suspect: string | null;
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
// is read up to this many times; deeper is suspect.
export const MAX_DEPTH = 8;
/** Longest text after `data:` the rule decodes; a longer one is suspect unread. */
export const MAX_URL_LENGTH = 65_536;
/** Most decoded texts one literal may give; more is suspect. */
export const MAX_TEXTS = 1024;
// `&` before a letter or `#` starts what HTML, XML or WebVTT may read as a
// character reference (`&eacute`, `&#154;`); none is decoded.
const REFERENCE = /&[#\p{L}]/u;
const STILL_ENCODED = /%[0-9a-fA-F]{2}|data:/iu;
// RFC 9110 token characters around a slash, with HTTP whitespace around it
// (the sets are disjoint, so the match is linear); anything else is unclear.
const TOKEN = "[!#$%&'*+.^_`|~0-9a-z-]+";
const ESSENCE = new RegExp(`^[\\t\\n\\f\\r ]*(${TOKEN})/(${TOKEN})[\\t\\n\\f\\r ]*$`, "u");
// Types a browser sniffs, and so may render as HTML (WHATWG MIME Sniffing 7.1).
const SNIFFED = new Set(["unknown/unknown", "application/unknown", "*/*"]);

/** True when a media type (ASCII-lowercased, as before the comma) reads references or is unclear. */
export function isStrictType(mime: string): boolean {
  const match = ESSENCE.exec(mime.split(";")[0] ?? "");
  if (!match) return true;
  const [type, subtype] = [match[1] ?? "", match[2] ?? ""];
  // HTML, XHTML, XML and its family (`+xml`, XSL) and WebVTT read references.
  return (
    SNIFFED.has(`${type}/${subtype}`) ||
    ["html", "xml", "xsl"].some((part) => subtype.includes(part)) ||
    `${type}/${subtype}` === "text/vtt"
  );
}

type State = { out: Set<string>; suspect: string | null };
const flag = (state: State, why: string): void => {
  state.suspect ??= why;
};

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
  // A UTF-16 byte order mark wins over the label when a page is rendered.
  const bom = bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : null;
  const utf16 = bom ?? (bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : null);
  if (utf16) texts.push(new TextDecoder(utf16).decode(bytes));
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

// JSON and JS escapes a body keeps for its reader: `\\uXXXX` (a surrogate pair
// written as two escapes is one character), `\\u{…}` and `\\xXX`, digit runs
// read whole (Codex P2 on #82). HTML references are not decoded (fail closed).
const JS_ESCAPE = /\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/gu;
const codeText = (code: number): string => (code <= 0x10ffff ? String.fromCodePoint(code) : "�");
function unescapeText(text: string): string {
  return text.replace(JS_ESCAPE, (_, braced?: string, unit?: string, byte?: string) =>
    braced === undefined
      ? String.fromCharCode(Number.parseInt(unit ?? byte ?? "0", 16))
      : codeText(Number.parseInt(braced, 16)),
  );
}

// A decoded text, and every text it gives when percent-decoded or unescaped
// again or when it holds a data: URL itself. Each text is read once.
function layers(text: string, mime: string, strict: boolean, depth: number, state: State): void {
  if (strict && REFERENCE.test(text)) flag(state, text);
  if (state.out.has(text)) return;
  state.out.add(text);
  if (state.out.size > MAX_TEXTS) return flag(state, `more than ${MAX_TEXTS} decoded texts`);
  if (depth >= MAX_DEPTH) {
    if (STILL_ENCODED.test(text)) flag(state, `encoded more than ${MAX_DEPTH} times: ${text}`);
    return;
  }
  const next = /%[0-9a-fA-F]{2}/u.test(text) ? bytesToTexts(percentDecode(text), mime) : [];
  next.push(unescapeText(text));
  for (const t of new Set(next)) if (t !== text) layers(t, mime, strict, depth + 1, state);
  collect(text, depth + 1, state);
}

function collect(text: string, depth: number, state: State): void {
  if (depth > MAX_DEPTH) return;
  const { input, folded } = normalizeUrlInput(text);
  // Wherever `data:` starts a scheme: at the start, or after a character no
  // scheme holds (an attribute quote, a space, a control).
  for (let at = folded.indexOf("data:"); at !== -1; at = folded.indexOf("data:", at + 1)) {
    if (at > 0 && SCHEME_CHAR.test(folded[at - 1] ?? "")) continue;
    const url = input.slice(at);
    // Size bound before any decoding: a longer URL is suspect, not read.
    if (url.length - "data:".length > MAX_URL_LENGTH) {
      flag(state, `data: URL longer than ${MAX_URL_LENGTH} characters`);
      continue;
    }
    // The URL runs to the end of the text, or, inside markup, CSS or a
    // sentence, up to the first character after the comma that ends it there
    // (Codex P2 on #82). A quote before the comma is a media type parameter
    // (`charset="utf-8"`), no end (review FAIL c.6904446769). A space ends it
    // only in the last cut, since base64 may hold spaces inside an attribute.
    const comma = url.indexOf(",");
    const cut = (end: RegExp): string => {
      const stop = comma === -1 ? -1 : url.slice(comma + 1).search(end);
      return stop === -1 ? url : url.slice(0, comma + 1 + stop);
    };
    const urls = new Set([url, cut(/["'`<>]/u), cut(/["'`<>)\s]/u)]);
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
      for (const rest of rests) readBody(rest, depth, state);
    }
  }
}

// The media type and body of a data: URL after `data:`, decoded.
function readBody(rest: string, depth: number, state: State): void {
  // The fragment is no part of the body (fetch, "data: URL processor").
  const hash = rest.indexOf("#");
  const end = hash === -1 ? rest.length : hash;
  const comma = rest.indexOf(",");
  if (comma === -1 || comma > end) return;
  const mime = asciiLower(rest.slice(0, comma));
  const body = percentDecode(rest.slice(comma + 1, end));
  // The media type is also read percent-decoded, through the same
  // normalization (`%42ase64` is `;Base64`, review FAIL c.6904446769).
  const decodedMime = normalizeUrlInput(Buffer.from(percentDecode(mime)).toString("latin1")).folded;
  const base64 = [mime, decodedMime].some((m) => /;\s*base64\s*$/u.test(m));
  // Strict when either reading of the type reads references or is unclear.
  const strict = isStrictType(mime) || isStrictType(decodedMime);
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
  for (const bytes of parts) {
    // A NUL byte in a strict body may be UTF-16, which hides `&` from the
    // readings above (an XML parser detects it without a label or BOM).
    if (strict && bytes.includes(0)) flag(state, "NUL byte in an HTML, XML or untyped body");
    for (const decoded of bytesToTexts(bytes, decodedMime))
      layers(decoded, decodedMime, strict, depth, state);
  }
}

/** Every text the data: URLs in `text` decode to, and why the rule must report unread. */
export function dataUrlFindings(text: string): DataUrlFindings {
  const state: State = { out: new Set(), suspect: null };
  collect(text, 0, state);
  return { texts: [...state.out], suspect: state.suspect };
}

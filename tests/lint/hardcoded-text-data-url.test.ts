import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import {
  dataUrlFindings,
  dataUrlProblem,
  MAX_DEPTH,
  MAX_TEXTS,
  MAX_URL_LENGTH,
  normalizeUrlInput,
  typeKind,
} from "../../scripts/lint-rules/index.ts";

// S-1L.2c (DAN-784): interface text hidden in a data: URL. The scheme is found
// as the WHATWG URL parser finds it (normalizeUrlInput), then the body is
// decoded. Review FAILs c.6896676607 and c.6896957758 on ductura/server#64.
// Fail closed after the cut of ductura/server#82: HTML references are not
// decoded; any `&` before a letter or `#` in an HTML, XML or untyped body
// fails, and so does markup (`<`) or an escape (a backslash) there; a byte
// that is not printable ASCII fails in any body that is not binary. Every
// bypass from the reviews of #82 and from the self-attack on this PR is a row.
// "xI1la2Fq" is base64 of "čekaj"; "8JCQgA" of U+10400 (a letter, a surrogate
// pair in UTF-16). All text is invented.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RULE = "local/no-hardcoded-text";
const eslint = new ESLint({
  cwd: ROOT,
  overrideConfigFile: path.join(ROOT, "eslint.config.ts"),
  flags: ["unstable_native_nodejs_ts_config"],
});

async function ids(code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(ROOT, "server/domain/x.ts") });
  const fatal = (result?.messages ?? []).filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(`parse error: ${fatal[0]?.message ?? ""}`);
  return (result?.messages ?? []).filter((m) => m.ruleId === RULE).map((m) => m.messageId ?? "");
}

// Each is a source-code string literal body (escapes as in TypeScript source).
const hidden: [what: string, literal: string][] = [
  ["lowercase", "data:text/plain;base64,xI1la2Fq"],
  ["upper case scheme", "DATA:text/plain;base64,xI1la2Fq"],
  ["mixed case scheme and flag", "DaTa:text/plain;BaSe64,xI1la2Fq"],
  ["tab in the scheme", "da\\tta:text/plain;base64,xI1la2Fq"],
  ["CR in the scheme", "dat\\ra:,%C4%8Dekaj"],
  ["LF in the scheme", "d\\nata:,%C4%8Dekaj"],
  ["CR LF before the colon", "data\\r\\n:,%C4%8Dekaj"],
  ["tab in the flag and body", "data:;base\\t64,xI1\\nla2Fq"],
  ["leading NUL", "\\u0000data:,%C4%8Dekaj"],
  ["leading form feed", "\\u000Cdata:,%C4%8Dekaj"],
  ["leading space and controls", " \\u0001\\u001Fdata:,%C4%8Dekaj"],
  ["trailing controls", "data:,%C4%8Dekaj\\u0000 "],
  ["after a markup quote", "<img src='data:,%C4%8Dekaj'>"],
  ["percent-encoded", "data:,%C4%8Dekaj"],
  ["percent-encoded lowercase hex", "data:,%c4%8dekaj"],
  ["double percent-encoded", "data:,%25C4%258Dekaj"],
  ["triple percent-encoded", "data:,%2525C4%25258Dekaj"],
  ["percent-encoded base64 body", "data:;base64,xI1la2E%3D"],
  ["percent-encoded base64 flag", "data:;%62ase64,xI1la2Fq"],
  ["space before the flag", "data:text/plain; base64,xI1la2Fq"],
  ["base64 without padding", "data:;base64,xI1la2E"],
  ["base64 with padding", "data:;base64,xI1la2E="],
  ["base64 with spaces", "data:;base64,xI1 la2 Fq"],
  ["base64 with form feed", "data:;base64,xI1\\u000Cla2Fq"],
  ["base64 with percent spaces", "data:;base64,xI1%20la2Fq"],
  ["URL-safe base64", "data:;base64,xI1la2F_"],
  ["sentence", "data:text/plain,Prijava%20je%20obavezna"],
  ["base64 sentence", "data:;base64,UHJpamF2YSBqZSBvYmF2ZXpuYQ=="],
  ["surrogate pair, percent-encoded UTF-8", "data:,%F0%90%90%80"],
  ["surrogate pair, base64 UTF-8", "data:;base64,8JCQgA=="],
  ["surrogate pair, CESU-8", "data:,%ED%A0%81%ED%B0%80"],
  ["surrogate pair, JSON escapes", "data:application/json,%22%5CuD801%5CuDC00%22"],
  ["surrogate pair, raw JSON escapes", 'data:application/json,\\"\\\\uD801\\\\uDC00\\"'],
  ["HTML character reference", "data:text/html,%26%23269;ekaj"],
  ["HTML named reference", "data:text/html,&ccaron;ekaj"],
  ["legacy charset", "data:text/plain;charset=windows-1250,%E8ekaj"],
  ["UTF-16 charset", "data:text/plain;charset=utf-16le,%0D%01"],
  ["nested data: URL", "data:,data:%252C%25C4%258Dekaj"],
  ["fragment after the text", "data:,%C4%8Dekaj#x"],
  ["query in the body", "data:,x?%C4%8Dekaj"],
  // Adversarial QA on DAN-784: dot segments move the first comma, and a bad
  // UTF-8 byte before a letter whose Latin-1 reading is no letter.
  ["dot segments", "data:/a,b/../;base64,xI1la2Fq"],
  ["encoded dot segments", "data:/a,b/%2e%2E/;base64,xI1la2Fq"],
  ["invalid UTF-8 before a letter", "data:,%80%D7%90%D7%91"],
  ["invalid UTF-8 before a letter, base64", "data:;base64,gNeQ15E="],
  // Codex P2 on #82: a base64 URL inside markup, and zero-padded references.
  ["base64 in a markup attribute", '<iframe src=\\"data:text/plain;base64,xI1la2Fq\\"></iframe>'],
  ["base64 in single quotes", "<img src='data:;base64,xI1la2Fq' alt=x>"],
  ["base64 with spaces in an attribute", "<a href='data:;base64,xI1 la2Fq'>x</a>"],
  ["base64 in CSS url()", "a { background: url(data:;base64,xI1la2Fq) }"],
  ["base64 before a space", "see data:;base64,xI1la2Fq for more"],
  // Review FAIL c.6904446769 on #82: a quoted media type parameter inside an
  // attribute, an encoded upper case flag, and markup left after the body.
  [
    "quoted charset in an attribute",
    "<iframe src='data:text/plain;charset=\\\"utf-8\\\";base64,xI1la2Fq'></iframe>",
  ],
  [
    "quoted charset, double-quoted attribute",
    "<a href=\\\"data:text/plain;charset='utf-8';base64,xI1la2Fq\\\">x</a>",
  ],
  ["encoded upper case flag", "data:;%42ase64,xI1la2Fq"],
  ["encoded upper case flag, all letters", "data:;%42%41%53%45%36%34,xI1la2Fq"],
  ["markup after the body", "data:;base64,xI1la2Fq}}]]>"],
  // Review FAIL c.6904968268 on #82: HTML reads 0x80–0x9F as windows-1252.
  ["windows-1252 reference, decimal", "data:text/html,%26%23154%3Balji"],
  ["windows-1252 reference, hex", "data:text/html,%26%23x9A%3Balji"],
  ["windows-1252 reference, upper case hex", "data:text/html,%26%23X9a%3Balji"],
  ["windows-1252 reference without a semicolon", "data:text/html,%26%23138alje"],
  ["windows-1252 reference, zero-padded", "data:text/html,%26%2300158%3Bivot"],
  ["windows-1252 reference in an attribute", "<iframe src='data:text/html,%26%23154%3Balji'>"],
  ["zero-padded decimal reference", "data:text/html,%26%2300000269%3Bekaj"],
  ["zero-padded hex reference", "data:text/html,%26%23x000010D%3Bekaj"],
  ["zero-padded JS escape", "data:application/json,%5Cu%7B0000010D%7Dekaj"],
  // Review FAIL c.6905456712 on #82: a named reference without `;`.
  ["named reference without a semicolon", "data:text/html,%26eacute"],
  ["raw named reference without a semicolon", "data:text/html,&eacute"],
  ["double percent-encoded reference", "data:text/html,%2526eacute"],
  ["reference in a base64 HTML body", "data:text/html;base64,JmVhY3V0ZQ=="],
  ["reference in an SVG body", "data:image/svg+xml,%3Ctext%3E%26eacute%3C/text%3E"],
  ["reference in XHTML", "data:application/xhtml+xml,%26scaron;"],
  ["reference in XML", "data:text/xml,%26%23x161;"],
  ["reference in WebVTT", "data:text/vtt,%26eacute"],
  ["reference in a sniffed type", "data:unknown/unknown,%26eacute"],
  ["upper case HTML type", "data:TEXT/HTML,%26eacute"],
  ["percent-encoded HTML type", "data:text%2Fhtml,%26eacute"],
  ["HTML type with spaces and a charset", "data: text/html ;charset=utf-8,%26eacute"],
  ["HTML reference in an attribute", "<iframe src='data:text/html,%26eacute'></iframe>"],
  // Fail closed: no type, or a type that cannot be read, is HTML.
  ["reference with no type", "data:,%26eacute"],
  ["reference with only the base64 flag", "data:;base64,JmVhY3V0ZQ=="],
  ["reference with a type without a subtype", "data:html,%26eacute"],
  ["reference with a type without a type", "data:/a,%26eacute"],
  ["reference with a parameter only", "data:;charset=utf-8,%26eacute"],
  // No reference is decoded, so markup ones fail too (they passed on #82).
  ["markup reference", "data:text/html,&lt;b&gt;ok&lt;/b&gt;"],
  ["named references in a sentence", "data:text/html,&copy; 2026 ACME &mdash; ok"],
  ["reference past U+10FFFF", "data:text/html,%26%2399999999999%3B"],
  ["NUL reference", "data:text/html,%26%230%3B"],
  ["surrogate references", "data:text/html,%26%23xD801%3B%26%23xDC00%3B"],
  // UTF-16 in a strict body hides `&` from a UTF-8 reading.
  ["UTF-16 with a byte order mark", "data:text/html,%FE%FF%00%26%00e%00a%00c%00u%00t%00e"],
  ["UTF-16 without a byte order mark", "data:application/xml,%00%26%00e%00a%00c%00u%00t%00e"],
  ["UTF-16 byte order mark over the type", "data:application/json,%FF%FE%0D%01"],
  // Self-attack on this PR: the reader's charset decides a byte past ASCII.
  ["windows-1252 fallback of an untyped body", "data:,%9Aalji"],
  ["windows-1250 fallback of a text body", "data:text/plain,%B9ekaj"],
  ["valid UTF-8 read as windows-1252", "data:text/plain,%C2%B9"],
  [
    "quoted charset parameter",
    'data:text/plain;x=\\"a;charset=utf-16le\\";charset=windows-1250,%B9%20',
  ],
  [
    "XML encoding declaration",
    "data:image/svg+xml,<?xml encoding='windows-1250'?><svg>%E8ekaj</svg>",
  ],
  ["ISO-2022-JP escape", "data:text/plain,%1B$B$3$s%1B(B"],
  ["HTML meta charset", "data:text/html,<meta charset=windows-1250>%B9"],
  // Markup or escapes in a strict body may build text.
  ["CSS escape in a style", 'data:text/html,<style>b::before{content:\\"\\\\10D ekaj\\"}</style>'],
  ["script in HTML", "data:text/html,<script>document.write(String.fromCharCode(269))</script>"],
  ["markup in HTML", "data:text/html,%3Cb%3Eok%3C/b%3E"],
  ["markup in SVG", "data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22/%3E"],
  ["markup in a base64 SVG", "data:image/svg+xml;base64,PGI+b2s8L2I+"],
  ["escape in PDF", "data:application/pdf,(%5C350ekaj)"],
  ["backslash in an untyped body", "data:,%5C10D"],
  // Second self-attack on this PR: CSS escapes, scripts, deeper bytes.
  ["CSS escape in a stylesheet", 'data:text/css,b::after{content:\\"\\\\10D ekaj\\"}'],
  ["reference in a stylesheet", "data:text/css,%26eacute"],
  ["any script body", "data:text/javascript,document.write(1)"],
  ["any script body, alias", "data:application/x-javascript,x"],
  ["windows-1252 byte one layer down", "data:text/plain,%259Aalji"],
  // Codex P2 on #95: an HTML attribute resolves references before the URL
  // parser, so a raw reference anywhere in the URL fails, whatever the type.
  ["reference in a text/plain attribute", "<iframe src='data:text/plain,&#269;ekaj'></iframe>"],
  ["named reference in a text/plain attribute", "<a href='data:text/plain,&ccaron;ekaj'>x</a>"],
  ["reference after the fragment mark", "data:text/plain,x&#35;&#269;"],
  ["reference in the fragment", "data:text/html,&#269;ekaj"],
  ["reference in the media type", "data:text/plain&#59;base64,xI1la2Fq"],
  ["scheme spelled with a reference", "<iframe src='&#100;ata:,%C4%8Dekaj'>"],
  ["scheme letter as a hex reference", "<iframe src='d&#x61;ta:,%C4%8Dekaj'>"],
  ["scheme colon as a named reference", "<iframe src='data&colon;,%C4%8Dekaj'>"],
  ["scheme spelled only with references", "&#100;&#97;&#116;&#97;&#58;,%C4%8Dekaj"],
  ["tab reference inside the scheme", "<a href='d&Tab;ata:,%C4%8Dekaj'>"],
  // Review FAIL cxcrs95 on #95: a numeric reference without `;` ends at its
  // last digit, so the scheme letters after it are no part of it.
  ["decimal reference without a semicolon", "<iframe src='&#100ata:text/plain;base64,xI1la2Fq'>"],
  ["letter reference without a semicolon", "<iframe src='d&#97ta:,%C4%8Dekaj'>"],
  ["hex reference without a semicolon", "<iframe src='&#x64&#x61ta:,%C4%8Dekaj'>"],
  ["non-UTF-8 byte one layer down", "data:application/json,%25E8ekaj"],
  // base64 is a flag in any parameter position.
  ["base64 before another parameter", "data:text/plain;base64;x=y,xI1la2Fq"],
  ["base64 before a charset", "data:text/plain;base64;charset=utf-8,xI1la2Fq"],
];

describe("data: URL", () => {
  it.each(hidden)("fails with interface text in the body: %s", async (_what, literal) => {
    expect(await ids(`export const u = "${literal}";`)).toContain("dataUrl");
  });

  it("fails on an expression before the comma, which may set the type or the comma", async () => {
    expect(await ids("export const u = (x: string) => `data:${x}%C4%8Dekaj`;")).toContain(
      "dataUrl",
    );
    expect(await ids("export const u = (x: string) => `data:${x}&eacute`;")).toContain("dataUrl");
    expect(await ids("export const u = (x: string) => `data:te${x}xt/plain,a`;")).toContain(
      "dataUrl",
    );
    expect(await ids("export const u = (x: string) => `da${x}ta:,a`;")).toContain("dataUrl");
    // Second self-attack: a scheme character before the expression.
    for (const code of [
      "(y: string, z: string) => `a${y}data:${z},%C4%8Dekaj`",
      "(y: string) => `a${y}data:,${y}%C4%8Dekaj`",
      "(y: string, z: string) => `a${y}data:te${z}xt/html,&eacute`",
      "(y: string) => `x${y}data:text/html,%26${y}eacute`",
    ])
      expect(await ids(`export const u = ${code};`), code).toContain("dataUrl");
    expect(await ids("export const u = (x: string) => `data:text/plain,${x}ok`;")).toEqual([]);
    expect(await ids("export const u = (x: string) => `${x} data`;")).toEqual([]);
  });

  it("fails in a template, in JSX-free code across an expression and in a regex", async () => {
    expect(await ids("export const u = `DATA:,%C4%8Dekaj`;")).toContain("dataUrl");
    expect(await ids("export const u = (x: string) => `data:,${x}%C4%8D`;")).toContain("dataUrl");
    expect(await ids("export const u = /data:,%C4%8Dekaj/u;")).toContain("dataUrl");
  });

  it("passes with ASCII content that is not interface text", async () => {
    for (const literal of [
      "data:text/plain,hello",
      "data:,",
      "data:application/json;base64,eyJvayI6dHJ1ZX0=",
      "data:text/plain;charset=utf-8,status%3Dok",
      "DATA:text/plain,%20missing%20index",
      "metadata:,%C4%8Dekaj",
      "data:no-comma-%C4%8Dekaj",
      "data:,x#%C4%8Dekaj",
      "da\\u000Cta:,%C4%8Dekaj",
      // Binary and markup that is not text (QA on DAN-784).
      "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
      "data:application/octet-stream,%FF%D8%FF%E0",
      "<img src='data:;base64,aGVsbG8=' alt='ok'>",
      // A reference is read only where the type reads it.
      "data:text/plain,%26eacute",
      "Tom &amp; Jerry, a &lt; b",
      "data:application/json,%7B%22a%22%3A%22%26eacute%22%7D",
      "data:text/css,a%7Bcolor:red%7D",
      "data:text/plain;base64,JmVhY3V0ZQ==",
      // HTML with no markup, or `&` before no letter and no `#`.
      "data:text/html,ok",
      "data:text/html,a%20%26%20b",
      "data:text/html,a&1",
      "data:text/html,ok&",
      // A text type keeps markup and escapes as text.
      "data:text/plain,%3Cb%3E%5C10D",
      "data:text/javascript,",
    ])
      expect(await ids(`export const u = "${literal}";`), literal).toEqual([]);
  });
});

describe("normalizeUrlInput", () => {
  it("strips C0 and space at the ends, removes tab and newlines, folds ASCII case", () => {
    expect(normalizeUrlInput("\u0000 \u001F Da\tT\na\r:X,Y \u0000")).toEqual({
      folded: "data:x,y",
      input: "DaTa:X,Y",
    });
    // A form feed inside is kept: `da\fta:` is no data: URL.
    expect(normalizeUrlInput("da\u000Cta:").input).toBe("da\u000Cta:");
    // Only ASCII is folded, so indices stay the same (İ would grow).
    expect(normalizeUrlInput("İD").folded).toBe("İd");
    // Linear on a long run of spaces (the trailing strip is no regex).
    const t0 = performance.now();
    expect(normalizeUrlInput(`a${" ".repeat(200_000)}x`).input).toHaveLength(200_002);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("is the one input every check reads", () => {
    expect(dataUrlProblem("\tDA\nTA\r:;BASE\t64,xI1la2Fq")).toBe("čekaj");
    expect(dataUrlProblem("data:text/plain,ok")).toBeNull();
  });
});

describe("fail closed", () => {
  it("reads the type of the body", () => {
    for (const mime of ["", ";base64", "html", "/a", "text/", "text/html", " text/html ;x=y"])
      expect(typeKind(mime), mime).toBe("strict");
    for (const mime of ["image/svg+xml", "application/xhtml+xml", "text/xml", "text/xsl"])
      expect(typeKind(mime), mime).toBe("strict");
    for (const mime of ["text/vtt", "unknown/unknown", "application/unknown", "*/*"])
      expect(typeKind(mime), mime).toBe("strict");
    expect(typeKind("application/pdf")).toBe("strict");
    expect(typeKind("text/css;charset=utf-8")).toBe("strict");
    for (const mime of ["text/javascript", "application/x-javascript", "text/ecmascript"])
      expect(typeKind(mime), mime).toBe("script");
    for (const mime of ["text/plain", "application/json", "text/csv", "x/y"])
      expect(typeKind(mime), mime).toBe("text");
    for (const mime of ["image/gif", "audio/ogg", "font/woff2", "application/octet-stream"])
      expect(typeKind(mime), mime).toBe("binary");
  });

  it("names the reference it does not decode", () => {
    expect(dataUrlProblem("data:text/html,%26eacute")).toBe("&eacute");
    expect(dataUrlFindings("data:text/plain,%26eacute").suspect).toBeNull();
  });

  it("does not decode a URL longer than the limit", () => {
    const long = `data:text/plain,${"a".repeat(MAX_URL_LENGTH + 1)}`;
    const findings = dataUrlFindings(long);
    expect(findings.suspect).toMatch(/longer than/u);
    expect(findings.texts).toEqual([]);
    expect(
      dataUrlFindings(`data:text/plain,${"a".repeat(MAX_URL_LENGTH - 16)}`).suspect,
    ).toBeNull();
  });

  it("fails on a body still encoded past the depth limit", () => {
    const deep = `data:text/plain,%${"25".repeat(MAX_DEPTH + 1)}41`;
    expect(dataUrlFindings(deep).suspect).toMatch(/encoded more than/u);
    expect(dataUrlFindings(`data:text/plain,%${"25".repeat(MAX_DEPTH - 2)}41`).suspect).toBeNull();
  });

  it("fails when a body decodes to too many texts", () => {
    // A binary type (no plain-byte rule) whose every layer UTF-8, windows-1250,
    // UTF-16 after the byte order mark and the JS escape read apart.
    const seed = "%FF%FE%E8";
    let body = seed;
    for (let i = 0; i < MAX_DEPTH - 1; i += 1) body = `${body.replaceAll("%", "%25")}${seed}\\x41`;
    const findings = dataUrlFindings(`data:image/png;charset=windows-1250,${body}`);
    expect(findings.suspect).toBe(`more than ${MAX_TEXTS} decoded texts`);
  });

  it("fails on more data: URLs in a row than the depth limit, and fast", () => {
    // Each URL's body holds the next one, read as nested.
    expect(dataUrlFindings("data:,a ".repeat(MAX_DEPTH + 2)).suspect).toMatch(/encoded more/u);
    expect(dataUrlFindings("data:,a ".repeat(MAX_DEPTH + 1)).suspect).toBeNull();
    // Self-attack on this PR: 60 000 characters of `data:,` took 99 s.
    const t0 = performance.now();
    expect(dataUrlFindings("data:,".repeat(10_000)).suspect).not.toBeNull();
    expect(performance.now() - t0).toBeLessThan(5000);
  });

  it("fails on a JS escape left at the depth limit", () => {
    // Codex P2 on #95: the JSON string "\\u010d" wrapped in base64 data: URLs.
    let url = "data:application/json;base64,Ilx1MDEwZCI=";
    for (let i = 0; i < MAX_DEPTH; i += 1)
      url = `data:text/plain;base64,${Buffer.from(url).toString("base64")}`;
    expect(dataUrlProblem(url)).not.toBeNull();
    expect(dataUrlFindings(url).suspect).toMatch(/encoded more than/u);
  });

  it("fails on a nested scheme with a tab left at the depth limit", () => {
    // Review FAIL cxcrs95 on #95: `da\tta:` appears only at depth 8.
    const url = "data:text/plain,da%252525252525252509ta:text/plain;base64,xI1la2Fq";
    expect(dataUrlFindings(url).suspect).toMatch(/encoded more than/u);
    expect(dataUrlProblem(url)).not.toBeNull();
  });

  it("reads base64 in any parameter position, and the body as it is", () => {
    const { texts } = dataUrlFindings("data:text/plain;base64;x=y,aGVsbG8=");
    expect(texts).toContain("hello");
    expect(texts).toContain("aGVsbG8=");
  });
});

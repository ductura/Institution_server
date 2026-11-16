import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

import { dataUrlProblem, normalizeUrlInput } from "../../scripts/lint-rules/index.ts";

// S-1L.2c (DAN-784): interface text hidden in a data: URL. The scheme is found
// as the WHATWG URL parser finds it (normalizeUrlInput), then the body is
// decoded. Review FAILs c.6896676607 and c.6896957758 on ductura/server#64.
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
  ["zero-padded decimal reference", "data:text/html,%26%2300000269%3Bekaj"],
  ["zero-padded hex reference", "data:text/html,%26%23x000010D%3Bekaj"],
  ["zero-padded JS escape", "data:application/json,%5Cu%7B0000010D%7Dekaj"],
];

describe("data: URL", () => {
  it.each(hidden)("fails with interface text in the body: %s", async (_what, literal) => {
    expect(await ids(`export const u = "${literal}";`)).toContain("dataUrl");
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
      "data:image/svg+xml,%3Csvg%20xmlns%3D%22http://www.w3.org/2000/svg%22/%3E",
      "data:text/html,&lt;b&gt;ok&lt;/b&gt;",
      "metadata:,%C4%8Dekaj",
      "data:no-comma-%C4%8Dekaj",
      "data:,x#%C4%8Dekaj",
      "data:text/html,&#269;ekaj",
      "da\\u000Cta:,%C4%8Dekaj",
      // Binary and markup that is not text (QA on DAN-784).
      "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
      "data:application/octet-stream,%FF%D8%FF%E0",
      "data:text/html,&copy; 2026 ACME &mdash; ok",
      "<img src='data:;base64,aGVsbG8=' alt='ok'>",
      "data:text/html,%26%2399999999999%3B",
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

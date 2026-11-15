// No interface text is written in server code (S-1L.2, DAN-780). Server code
// returns a key (`messageKey`, docs/CODE_STYLE.md §8); the text is in
// locales/. The rule reads only what stands in the source and never works out
// what a piece of code would build (orchestrator decision Ductus#87
// c.6896146643): no constant resolution, no `.join`, no spread, no length cap.
//
// 1. Direct literals: a string literal, each static piece of a template, a JSX
//    text and a name (identifier) are interface text when they
//    hold a letter outside ASCII or a Croatian sentence (textProblem, the
//    measure of ductura/server#51). A literal that spells a non-ASCII
//    character in an encoded form (`\\u010d`, `%C4%8D`, `&#269;`) is reported
//    too, since JSON.parse, URLSearchParams or a browser decode it.
// 2. Exceptions: tests and fixtures (TEXT_EXEMPT) and the transitional
//    TEXT_TRANSITIONAL. Server code may not import an exempt file.
//
// Text builders (escapes, fromCharCode, decoders) are DAN-780 part b.
//
// What lint cannot see, left to review and to DAN-782: text built at run time
// from numbers or bytes (`buf.toString()` of a computed array, a lookup through
// a computed key, `.source` of a regex fed to a decoder), and English sentences.
import { posix, win32 } from "node:path";
import type { Rule } from "eslint";

type Node = Rule.Node;
type Loose = {
  type: string;
  name?: string;
  value?: unknown;
  raw?: string;
  computed?: boolean;
  declare?: boolean;
  kind?: string;
  object?: Loose;
  property?: Loose;
  parent?: Loose;
  callee?: Loose;
  arguments?: Loose[];
  expressions?: Loose[];
  source?: Loose | null;
  tag?: Loose;
};

/** Tests and fixtures, which production code may not import. */
export const TEXT_EXEMPT: readonly string[] = [
  "server/**/*.test.ts",
  // Invented log lines for the redact tests (server/log/README.md).
  "server/log/invented.fixture.ts",
];
/**
 * The transitional HTTP server, whose text moves to locales/ in DAN-782
 * (orchestrator decision Ductus#87 c.6896054840). server/index.ts was removed
 * in DAN-775, so it is not on the list.
 */
export const TEXT_TRANSITIONAL: readonly string[] = ["server/app.ts"];

/**
 * Croatian function words, folded to ASCII (č, ć → c, š → s, ž → z, đ → d),
 * from ductura/server#51. A STRONG word makes any text of two or more words a
 * sentence. A WEAK word is also a short English or technical token, so it
 * counts only in lowercase inside a text that starts with a capitalized word,
 * or in a text of three or more words in capitals.
 */
export const STRONG_WORDS: readonly string[] = [
  ...["je", "se", "nije", "nisu", "nisam", "niste", "smo", "ste", "biti", "bila", "bilo"],
  ...["nece", "cemo", "cete", "ili", "ali", "jer", "kod", "bez", "prema", "nakon", "prije"],
  ...["preko", "nema", "nemate", "imate", "vas", "vam", "vasa", "vase", "vasi", "vasu", "vasim"],
  ...["ovaj", "ova", "ovo", "ovog", "ovom", "ove", "ovu", "taj", "koji", "koja", "koje"],
  ...["kojeg", "kojem", "kako", "sto", "gdje", "kada", "kad", "jos", "vec", "samo", "sve"],
  ...["svi", "molimo", "mozete", "moze", "mogu", "morate", "treba", "trebate", "pokusajte"],
  ...["ponovno", "nemoguce", "uspjesno"],
];
export const WEAK_WORDS: readonly string[] = [
  ...["u", "i", "da", "ne", "na", "te", "sa", "su", "za", "od", "iz", "bi", "pa", "ce"],
  ...["sam", "bio", "ima"],
];
const STRONG = new Set(STRONG_WORDS);
const WEAK = new Set(WEAK_WORDS);
const NON_ASCII_LETTER = /(?=[\p{L}\p{M}])\P{ASCII}/u;
// Invisible format and control characters, but not tab and line ends.
const INVISIBLE = /(?![\t\n\r])[\p{Cf}\p{Cc}]/gu;
// One machine token with no space: a snake, kebab or dotted name, an
// UPPER_SNAKE code, or a key with camelCase segments (`auth.signIn`).
const TOKEN = [
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u,
  /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/u,
  /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9_]*)+$/u,
];

function isSentence(text: string): boolean {
  if (TOKEN.some((re) => re.test(text))) {
    const parts = text.toLowerCase().split(/[._-]/u);
    return parts.length >= 3 && parts.some((w) => STRONG.has(w));
  }
  // Not words: a snake_case value quoted in SQL and a query key (`?prije=`).
  const plain = text
    .replace(/'[a-z0-9]+(?:_[a-z0-9]+)+'/gu, " ")
    .replace(/(^|[?&])[A-Za-z]+=/gu, "$1 ");
  const words = plain.match(/[A-Za-z]+/gu) ?? [];
  if (words.length < 2) return false;
  if (words.some((w) => STRONG.has(w.toLowerCase()))) return true;
  const capitalized = /^[^A-Za-z]*[A-Z][a-z]/u.test(plain);
  const capitals = words.length >= 3 && !/[a-z]/u.test(plain);
  return words.some(
    (w) => WEAK.has(w.toLowerCase()) && ((capitalized && w === w.toLowerCase()) || capitals),
  );
}

/** Why `text` is interface text, or null when it is not. */
export function textProblem(text: string): "letter" | "sentence" | null {
  if (NON_ASCII_LETTER.test(text)) return "letter";
  // NFKC turns compatibility letters (ⓙ) into ASCII; an invisible character
  // is read both as nothing and as a space.
  const base = text.normalize("NFKC");
  if (NON_ASCII_LETTER.test(base)) return "letter";
  const variants = [base.replace(INVISIBLE, ""), base.replace(INVISIBLE, " ")];
  return variants.some(isSentence) ? "sentence" : null;
}

// Escapes in source text, after an even run of backslashes: their code points.
const ESCAPE = /(?<!\\)(?:\\\\)*\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2}))/gu;
function escapedCodes(raw: string): number[] {
  const units = [...raw.matchAll(ESCAPE)].map((m) => ({
    code: Number.parseInt(m[1] ?? m[2] ?? m[3] ?? "0", 16),
    end: (m.index ?? 0) + m[0].length,
    start: m.index ?? 0,
  }));
  // A high and a low surrogate written one after the other are one code point
  // (review FAIL on #64: `\\uD801\\uDC00` is U+10400).
  const codes: number[] = [];
  for (let i = 0; i < units.length; i += 1) {
    const high = units[i];
    const low = units[i + 1];
    if (
      high &&
      low &&
      high.code >= 0xd800 &&
      high.code <= 0xdbff &&
      low.code >= 0xdc00 &&
      low.code <= 0xdfff &&
      high.end === low.start
    ) {
      codes.push(0x10000 + (high.code - 0xd800) * 0x400 + (low.code - 0xdc00));
      i += 1;
    } else if (high) codes.push(high.code);
  }
  return codes;
}
/** Whether a text spells a non-ASCII character in an encoded form. */
// A code point that is a letter or a mark outside ASCII (not a control or a space).
const isLetterCode = (code: number): boolean =>
  code > 0x7f && code <= 0x10ffff && NON_ASCII_LETTER.test(String.fromCodePoint(code));
export function encodesNonAscii(text: string): boolean {
  if (escapedCodes(text).some(isLetterCode)) return true;
  // A UTF-8 lead byte and a continuation byte, percent-encoded.
  if (/%[c-fC-F][0-9a-fA-F]%[89abAB][0-9a-fA-F]/u.test(text)) return true;
  // A data: URL, a punycode label.
  if (/\bdata:[^,\s]*,/iu.test(text) || /(?:^|[./@])xn--/iu.test(text)) return true;
  const entities = text.matchAll(/&#(?:([0-9]+)|[xX]([0-9a-fA-F]+));?/gu);
  if ([...entities].some((m) => isLetterCode(Number.parseInt(m[1] ?? m[2] ?? "0", m[1] ? 10 : 16))))
    return true;
  const named = [...text.matchAll(/&([A-Za-z][A-Za-z0-9]*);/gu)].map((m) => m[1] ?? "");
  return named.some((n) => !["amp", "lt", "gt", "quot", "apos"].includes(n));
}

/** A repository path of the linted file, with `/` separators, also on Windows. */
export function repoPath(cwd: string, filename: string): string {
  const windows = /^[A-Za-z]:[\\/]/u.test(cwd) || /^[A-Za-z]:[\\/]/u.test(filename);
  const rel = windows ? win32.relative(cwd, filename) : posix.relative(cwd, filename);
  return posix.normalize(rel.replaceAll("\\", "/"));
}
/** Whether a repository path is on TEXT_EXEMPT. */
export function isExempt(file: string): boolean {
  return (
    (file.startsWith("server/") && file.endsWith(".test.ts")) || TEXT_EXEMPT.slice(1).includes(file)
  );
}

export const noHardcodedText: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Interface text lives in locales/, not in server code (DAN-780)" },
    schema: [],
    messages: {
      letter:
        "Text with a non-ASCII letter ({{text}}): move it to locales/ and return a messageKey.",
      sentence: "Croatian sentence ({{text}}): move it to locales/ and return a messageKey.",
      encoded: "An encoded non-ASCII character ({{text}}) is interface text in another form.",
      exempt: "Server code may not import '{{spec}}': it is a test or fixture (TEXT_EXEMPT).",
    },
  },
  create(context) {
    const file = repoPath(context.cwd, context.filename);

    function checkText(node: Node, text: string): void {
      const problem = textProblem(text);
      if (problem) {
        context.report({ node, messageId: problem, data: { text: JSON.stringify(text) } });
      } else if (encodesNonAscii(text)) {
        context.report({ node, messageId: "encoded", data: { text: JSON.stringify(text) } });
      }
    }

    function checkName(node: Node): void {
      const id = node as unknown as Loose;
      const name = id.name ?? "";
      if (NON_ASCII_LETTER.test(name)) {
        context.report({ node, messageId: "letter", data: { text: JSON.stringify(name) } });
      }
    }

    function checkSource(node: Node, source: Loose | null | undefined): void {
      const spec = typeof source?.value === "string" ? source.value : "";
      if (!spec.startsWith(".")) return;
      if (isExempt(posix.normalize(posix.join(posix.dirname(file), spec))))
        context.report({ node, messageId: "exempt", data: { spec } });
    }

    return {
      "Identifier, PrivateIdentifier, JSXIdentifier": checkName,
      // A template is also read as one text, its expressions as word breaks.
      TemplateLiteral(node) {
        const quasis = (node as unknown as { quasis: { value: { cooked?: string | null } }[] })
          .quasis;
        if (quasis.length < 2) return;
        const text = quasis.map((q) => q.value.cooked ?? "").join(" ");
        if (quasis.some((q) => textProblem(q.value.cooked ?? ""))) return;
        const problem = textProblem(text);
        if (problem)
          context.report({ node, messageId: problem, data: { text: JSON.stringify(text) } });
      },
      Literal(node) {
        const literal = node as unknown as Loose;
        if (typeof literal.value === "string") checkText(node, literal.value);
        // A regex pattern is text through `.source`: letters as \\u escapes.
        const pattern = (literal as { regex?: { pattern: string } }).regex?.pattern;
        const problem = pattern === undefined ? null : textProblem(pattern);
        if (problem)
          context.report({ node, messageId: problem, data: { text: JSON.stringify(pattern) } });
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw);
      },
      JSXText(node: Node) {
        const text = String((node as unknown as Loose).value ?? "");
        checkText(node, text);
      },
      ImportDeclaration: (node) => checkSource(node, node.source as Loose),
      ExportNamedDeclaration: (node) => checkSource(node, node.source as Loose | null),
      ExportAllDeclaration: (node) => checkSource(node, node.source as Loose),
      ImportExpression: (node) => checkSource(node, node.source as Loose),
    };
  },
};

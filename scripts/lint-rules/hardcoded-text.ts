// No interface text is written in server code (S-1L.2, DAN-780). Server code
// returns a key (`messageKey`, docs/CODE_STYLE.md §8); the text is in
// locales/. The rule reads every string the code writes as one text, also
// when it is built from pieces the rule can see, and reports two kinds:
//
// - "letter": any letter or combining mark outside ASCII. Croatian letters
//   are the case the task names; the same check also catches a letter
//   written as a homoglyph, in another script, decomposed (c + U+030C) or in
//   full width, and a `č` escape, which the parser has already decoded.
// - "sentence": at least two words, one of them a Croatian function word
//   from WORDS (`je`, `nije`, `za` ...), so a sentence without diacritics
//   ("Prijava je obavezna.") is caught. Words are runs of ASCII letters, so
//   "Prijava_je-obavezna" is three words. One machine token (TOKEN: a key
//   `auth.signIn`, a code `NOT_FOUND`, a header `content-type`, a wire value
//   `nije_ukljuceno`) is not a sentence.
//
// Pieces the rule joins: a template literal (its expressions are folded when
// they are strings, otherwise stand as a word break), `+` concatenation, an
// array of string literals (joined with "" and with " "), String.fromCharCode
// and String.fromCodePoint with number literals, and the percent-decoded and
// base64-decoded form of a literal. Only the outermost piece is reported, once.
//
// What lint cannot see: text built at run time from values it cannot fold
// (a lookup, a loop, arithmetic on char codes), English sentences, which are
// not told apart from developer messages of programming errors (§8), and a
// Croatian sentence with none of the WORDS. Review covers them.
//
// Exceptions are paths only, the closed list TEXT_EXEMPT (tests and
// fixtures). Production code may not import an exempt file, so a constant
// written there cannot reach server code.
import { posix } from "node:path";
import type { Rule } from "eslint";

type Node = Rule.Node;
type Loose = {
  type: string;
  value?: unknown;
  regex?: unknown;
  operator?: string;
  left?: Loose;
  right?: Loose;
  parent?: Loose;
  expressions?: Loose[];
  quasis?: { value: { cooked?: string | null; raw: string } }[];
  elements?: (Loose | null)[];
  callee?: Loose;
  object?: Loose;
  property?: Loose;
  computed?: boolean;
  name?: string;
  arguments?: Loose[];
  source?: Loose | null;
  quasi?: Loose;
};

/**
 * The only server files the rule does not read: tests and fixtures. A closed
 * list of patterns; tests/lint/hardcoded-text.test.ts checks every fixture
 * path exists and that nothing else is left out.
 */
export const TEXT_EXEMPT: readonly string[] = [
  "server/**/*.test.ts",
  // Invented log lines for the redact tests (server/log/README.md).
  "server/log/invented.fixture.ts",
];

/**
 * Croatian function words, folded to ASCII (č, ć → c, š → s, ž → z, đ → d).
 * Words that are also English or technical tokens are left out on purpose
 * (`to`, `on`, `i`, `do`).
 */
export const WORDS: readonly string[] = [
  ...["je", "nije", "su", "nisu", "sam", "nisam", "smo", "ste", "biti", "bio", "bila", "bilo"],
  ...["bi", "ce", "nece", "cemo", "cete", "ili", "ali", "jer", "pa", "te", "da", "ne", "u"],
  ...["za", "na", "od", "iz", "kod", "sa", "bez", "prema", "nakon", "prije", "preko"],
  ...["nema", "nemate", "imate", "ima", "vas", "vam", "vasa", "vase", "vasi", "vasu", "vasim"],
  ...["ovaj", "ova", "ovo", "ovog", "ovom", "ove", "ovu", "taj", "koji", "koja", "koje"],
  ...["kojeg", "kojem", "kako", "sto", "gdje", "kada", "kad", "jos", "vec", "samo", "sve"],
  ...["svi", "molimo", "mozete", "moze", "mogu", "morate", "treba", "trebate", "pokusajte"],
  ...["ponovno", "nemoguce", "uspjesno", "niste"],
];
const WORD_SET = new Set(WORDS);
const NON_ASCII_LETTER = /(?=[\p{L}\p{M}])\P{ASCII}/u;
// A placeholder for a part the rule cannot fold: a word break, not a word.
const HOLE = " ";
// One machine token with no space: a lowercase snake, kebab or dotted name
// (a wire value such as `nije_ukljuceno`, a header `content-type`), an
// UPPER_SNAKE error code, or a key with camelCase segments (`auth.signIn`).
// Mixed case joined by `_` or `-` ("Prijava-je-obavezna") is not one.
const TOKEN = [
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u,
  /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/u,
  /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9_]*)+$/u,
];

function isToken(text: string): boolean {
  return TOKEN.some((re) => re.test(text));
}

/** Why `text` is interface text, or null when it is not. */
export function textProblem(text: string): "letter" | "sentence" | null {
  // An invisible format character (U+200B ...) separates words like a space.
  const plain = text.replace(/\p{Cf}/gu, " ");
  if (NON_ASCII_LETTER.test(plain)) return "letter";
  if (isToken(plain)) return null;
  // Machine tokens inside a longer text are not words either: a snake_case
  // value in SQL (`'nije_konfigurirano'`), an UPPER_SNAKE code, a query key
  // (`?prije=`).
  const words =
    plain
      .replace(/\b(?:[a-z0-9]+(?:_[a-z0-9]+)+|[A-Z0-9]+(?:_[A-Z0-9]+)+)\b/gu, " ")
      .replace(/[A-Za-z]+=/gu, " ")
      .toLowerCase()
      .match(/[a-z]+/g) ?? [];
  return words.length >= 2 && words.some((w) => WORD_SET.has(w)) ? "sentence" : null;
}

/** The text a node writes when the rule can fold it, holes as HOLE; else null. */
function fold(node: Loose | undefined | null): string | null {
  if (!node) return null;
  if (node.type === "Literal") return typeof node.value === "string" ? node.value : null;
  if (node.type === "TemplateLiteral") {
    const parts: string[] = [];
    (node.quasis ?? []).forEach((q, i) => {
      parts.push(q.value.cooked ?? q.value.raw);
      const expr = node.expressions?.[i];
      if (expr) parts.push(fold(expr) ?? HOLE);
    });
    return parts.join("");
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = fold(node.left);
    const right = fold(node.right);
    return left === null && right === null ? null : (left ?? HOLE) + (right ?? HOLE);
  }
  if (node.type === "ArrayExpression") {
    const items = (node.elements ?? []).map((e) => fold(e));
    return items.some((i) => i !== null) ? items.map((i) => i ?? HOLE).join("") : null;
  }
  if (node.type === "CallExpression") return fromCharCodes(node);
  return null;
}

/** The text of `String.fromCharCode(...)` or `String.fromCodePoint(...)` with number literals. */
function fromCharCodes(node: Loose): string | null {
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.object?.name !== "String") return null;
  const key = callee.computed ? fold(callee.property) : callee.property?.name;
  if (key !== "fromCharCode" && key !== "fromCodePoint") return null;
  const codes = (node.arguments ?? []).map((a) => (a.type === "Literal" ? a.value : null));
  if (!codes.every((c): c is number => typeof c === "number" && Number.isInteger(c))) return null;
  try {
    return String.fromCodePoint(...codes);
  } catch {
    return null;
  }
}

/** The texts to check for one folded text: itself and its decoded forms. */
function readings(text: string, node: Loose): string[] {
  const out = [text];
  // String.raw and other tags see the raw form of a template.
  if (node.type === "TemplateLiteral")
    out.push((node.quasis ?? []).map((q) => q.value.raw).join(HOLE));
  if (node.type === "ArrayExpression") {
    // Joined as words; a multi-part machine token (`ne_radi`, `NOT_FOUND`) is
    // one value of a list, not a word of a sentence.
    const items = (node.elements ?? []).map((e) => fold(e) ?? HOLE);
    out.push(items.map((i) => (/[._-]|^[A-Z0-9]+$/u.test(i) && isToken(i) ? HOLE : i)).join(" "));
  }
  if (/%[0-9a-f]{2}/iu.test(text)) {
    try {
      out.push(decodeURIComponent(text));
    } catch {
      // Not a percent-encoded text.
    }
  }
  if (/^[A-Za-z0-9+/_-]{8,}={0,2}$/u.test(text)) {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    // Only a decoded form that is readable text, never random bytes.
    if (/^[\p{L}\p{N}\p{P}\p{Zs}]+$/u.test(decoded)) out.push(decoded);
  }
  return out;
}

// A node whose text is part of a larger foldable node is checked there.
function isOutermost(node: Loose): boolean {
  const parent = node.parent;
  if (!parent) return true;
  if (parent.type === "BinaryExpression" && parent.operator === "+") return false;
  if (parent.type === "TemplateLiteral") return false;
  if (parent.type === "ArrayExpression") return false;
  if (parent.type === "CallExpression" && fromCharCodes(parent) !== null) return false;
  return true;
}

function relative(context: Rule.RuleContext): string {
  return posix.normalize(posix.relative(context.cwd, context.filename.replaceAll("\\", "/")));
}

/** Whether a repository path is on TEXT_EXEMPT. */
export function isExempt(file: string): boolean {
  return TEXT_EXEMPT.some((pattern) =>
    pattern.startsWith("server/**/*")
      ? file.startsWith("server/") && file.endsWith(pattern.slice("server/**/*".length))
      : file === pattern,
  );
}

export const noHardcodedText: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Interface text lives in locales/, not in server code" },
    messages: {
      letter:
        "Text with a non-ASCII letter ({{text}}) is interface text: move it to locales/ and return a messageKey.",
      sentence:
        "Croatian sentence ({{text}}) is interface text: move it to locales/ and return a messageKey.",
      exempt: "Server code may not import '{{spec}}': it is a test or fixture (TEXT_EXEMPT).",
    },
    schema: [],
  },
  create(context) {
    const file = relative(context);
    function check(node: Node): void {
      const loose = node as unknown as Loose;
      if (loose.type === "Literal" && loose.regex) return;
      if (!isOutermost(loose)) return;
      const text = fold(loose);
      if (text === null) return;
      for (const reading of readings(text, loose)) {
        const problem = textProblem(reading);
        if (problem) {
          context.report({ node, messageId: problem, data: { text: JSON.stringify(reading) } });
          return;
        }
      }
    }
    function source(node: Node): void {
      const spec = fold((node as unknown as Loose).source);
      if (!spec?.startsWith(".")) return;
      const target = posix.normalize(posix.join(posix.dirname(file), spec));
      if (isExempt(target)) context.report({ node, messageId: "exempt", data: { spec } });
    }
    return {
      Literal(node) {
        check(node);
      },
      TemplateLiteral(node) {
        check(node);
      },
      BinaryExpression(node) {
        check(node);
      },
      ArrayExpression(node) {
        check(node);
      },
      CallExpression(node) {
        check(node);
      },
      ImportDeclaration(node) {
        source(node);
      },
      ExportNamedDeclaration(node) {
        source(node);
      },
      ExportAllDeclaration(node) {
        source(node);
      },
      ImportExpression(node) {
        source(node);
      },
    };
  },
};

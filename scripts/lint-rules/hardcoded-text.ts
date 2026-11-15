// No interface text is written in server code (S-1L.2, DAN-780). Server code
// returns a key (`messageKey`, docs/CODE_STYLE.md §8); the text is in
// locales/. The rule reads every string the code writes as one text, also
// when it is built from pieces the rule can see, and reports two kinds:
//
// - "letter": any letter or combining mark outside ASCII, in a string or in
//   a name (identifier). Croatian letters are the case the task names; the
//   same check catches a homoglyph, another script, a decomposed letter
//   (c + U+030C), full width and a `\u010D` escape, which the parser decodes.
// - "sentence": at least two words with a Croatian function word
//   (STRONG_WORDS, WEAK_WORDS), so a sentence without diacritics ("Prijava je
//   obavezna.") is caught. Words are runs of ASCII letters after NFKC (ⓙ is
//   j); an invisible or control character is read both as nothing and as a
//   space. One machine token (a key `auth.signIn`, a code `NOT_FOUND`, a
//   header `content-type`, a wire value `nije_ukljuceno`) is not a sentence
//   unless it has three or more parts and a strong word.
//
// What the rule folds: template literals (also tagged), `+`, `.concat`,
// String(x), ternaries, `??` and `||` (every branch), sequences, `as`,
// `satisfies` and `!`, arrays with spread (joined with "", " " and the
// separator of `.join`), a `const` name, String.fromCharCode and
// String.fromCodePoint (also with spread, `.apply` and `.call`), `.source`
// of a regex literal, and the percent, base64 and hex decoded forms of a text.
// A text is reported once, at the outermost node.
//
// What lint cannot see, left to review: text built at run time (`+=` in a
// loop, `.replace`, `.split().reverse()`, number bases, lookups through
// Object.keys or a `let`, a decoder applied twice, an alias of String),
// English sentences, which are not told apart from developer messages of
// programming errors (§8), a Croatian sentence with none of the listed words,
// and a two-part token (`nije.pronadeno`).
//
// Exceptions are paths only, the closed list TEXT_EXEMPT (tests and
// fixtures). Production code may not import an exempt file, so a constant
// written there cannot reach server code. The repository's global lint
// ignores (`dist/`, `coverage/`) must hold no file under server/; the test
// checks the tracked files.
import { posix } from "node:path";
import type { Rule, Scope } from "eslint";

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
  argument?: unknown;
  consequent?: Loose;
  alternate?: Loose;
  expression?: Loose;
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
 * A STRONG word makes any text of two or more words a sentence. A WEAK word
 * is also a short English or technical token (`u` in SQL, `da` in a language
 * list), so it counts only in lowercase inside a text that starts with a
 * capitalized word ("Dokument ne postoji."), or in a text of three or more
 * words in capitals. Left out on purpose: `to`, `on`, `do`, `s`.
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
// A placeholder for a part the rule cannot fold: a word break, not a word.
const HOLE = " ";
// At most this many alternative texts per node (a ternary has two).
const MAX_ALTERNATIVES = 32;
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

function isSentence(text: string): boolean {
  if (isToken(text)) {
    // A token of three or more parts with a strong word ("prijava-je-obavezna").
    const parts = text.toLowerCase().split(/[._-]/u);
    return parts.length >= 3 && parts.some((w) => STRONG.has(w));
  }
  // Not words: a snake_case value quoted in SQL ('nije_konfigurirano') and a
  // query key at the start of a parameter (`?prije=`).
  const plain = text
    .replace(/'[a-z0-9]+(?:_[a-z0-9]+)+'/gu, HOLE)
    .replace(/(^|[?&])[A-Za-z]+=/gu, `$1${HOLE}`);
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
  // NFKC turns enclosed and other compatibility letters (ⓙ) into ASCII. An
  // invisible character is read both as nothing ("j​e") and as a space.
  const base = text.normalize("NFKC");
  if (NON_ASCII_LETTER.test(base)) return "letter";
  const variants = [base.replace(INVISIBLE, ""), base.replace(INVISIBLE, " ")];
  return variants.some(isSentence) ? "sentence" : null;
}

/** Readable decoded forms of a text: percent, base64 and hex encodings. */
function decodings(text: string): string[] {
  const out: string[] = [];
  // Readable text (printable ASCII and Croatian letters), never random bytes.
  const readable = (t: string): boolean => /^[\x20-\x7E\t\n\rčćžšđČĆŽŠĐ]+$/u.test(t);
  if (/%[0-9a-f]{2}/iu.test(text)) {
    try {
      out.push(decodeURIComponent(text));
    } catch {
      // A broken tail: decode the valid escapes one by one.
      out.push(
        text.replace(/%[0-9a-f]{2}/giu, (m) => String.fromCharCode(parseInt(m.slice(1), 16))),
      );
    }
  }
  if (/^[A-Za-z0-9+/_-]{8,}={0,2}$/u.test(text)) {
    const decoded = Buffer.from(text, "base64").toString("utf8");
    if (readable(decoded)) out.push(decoded);
  }
  if (/^(?:[0-9a-f]{2}){4,}$/iu.test(text)) {
    const decoded = Buffer.from(text, "hex").toString("utf8");
    if (readable(decoded)) out.push(decoded);
  }
  return out;
}

type Resolve = (id: Loose) => Loose | null;

// Wrappers that leave the value of their expression as it is.
const WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
  "ChainExpression",
]);
// Methods of a string that keep its words.
const SAME_WORDS = new Set(["toString", "valueOf", "trim", "trimStart", "trimEnd", "normalize"]);
const CASE = new Set(["toLowerCase", "toUpperCase", "toLocaleLowerCase", "toLocaleUpperCase"]);

function cross(left: string[], right: string[]): string[] {
  return left.flatMap((l) => right.map((r) => l + r)).slice(0, MAX_ALTERNATIVES);
}

function memberName(node: Loose | undefined, fold: (n: Loose) => string[] | null): string | null {
  if (node?.type !== "MemberExpression") return null;
  if (!node.computed) return node.property?.name ?? null;
  return fold(node.property as Loose)?.[0] ?? null;
}

/**
 * The texts a node can write when the rule can fold it, holes as HOLE; null
 * when it writes nothing the rule can see.
 */
function makeFold(resolve: Resolve): (node: Loose | undefined | null) => string[] | null {
  const seen = new Set<Loose>();
  // Each node is folded once per file: a const shared by later ones
  // (`const n2 = n1 + n1`) would otherwise be folded again on every path.
  const done = new Map<Loose, string[] | null>();
  /**
   * The elements of an array as lists of items, one list per combination of
   * the elements' alternatives (a ternary in an element gives two), at most
   * MAX_ALTERNATIVES; spread arrays and strings are flattened.
   */
  function items(node: Loose): string[][] | null {
    let combos: string[][] = [[]];
    const add = (choices: string[][]): void => {
      combos = combos
        .flatMap((c) => choices.map((choice) => [...c, ...choice]))
        .slice(0, MAX_ALTERNATIVES);
    };
    for (const e of node.elements ?? []) {
      if (e?.type === "SpreadElement") {
        const arg = e.argument as Loose;
        const inner =
          arg.type === "ArrayExpression" ? items(arg) : fold(arg)?.map((t) => t.split(""));
        add(inner ?? [[HOLE]]);
      } else add((fold(e) ?? [HOLE]).map((t) => [t]));
    }
    return combos.some((c) => c.some((i) => i !== HOLE)) ? combos : null;
  }
  function call(node: Loose): string[] | null {
    const callee = node.callee;
    const args = node.arguments ?? [];
    const codes = charCodes(node, fold);
    if (codes !== null) return [codes];
    if (callee?.type === "Identifier" && callee.name === "String" && args.length === 1)
      return fold(args[0]);
    const name = memberName(callee, fold);
    const object = callee?.object;
    if (!name || !object) return null;
    if (name === "join" && object.type === "ArrayExpression") {
      const combos = items(object);
      if (!combos) return null;
      const seps = args[0] ? (fold(args[0]) ?? [HOLE]) : [","];
      return combos.flatMap((list) => [
        ...seps.map((sep) => list.join(sep)),
        list.join(""),
        list.join(" "),
      ]);
    }
    const base = fold(object);
    if (!base) return null;
    if (SAME_WORDS.has(name) || CASE.has(name)) return base;
    if (name === "concat") return args.reduce((acc, a) => cross(acc, fold(a) ?? [HOLE]), base);
    return null;
  }
  function fold(node: Loose | undefined | null): string[] | null {
    if (!node || seen.has(node)) return null;
    if (done.has(node)) return done.get(node) ?? null;
    seen.add(node);
    try {
      const result = foldNode(node);
      done.set(node, result);
      return result;
    } finally {
      seen.delete(node);
    }
  }
  function foldNode(node: Loose): string[] | null {
    switch (node.type) {
      case "Literal":
        return typeof node.value === "string" ? [node.value] : null;
      case "TemplateLiteral": {
        let acc = [""];
        (node.quasis ?? []).forEach((q, i) => {
          acc = cross(acc, [q.value.cooked ?? q.value.raw]);
          const expr = node.expressions?.[i];
          if (expr) acc = cross(acc, fold(expr) ?? [HOLE]);
        });
        return acc;
      }
      case "TaggedTemplateExpression":
        return fold(node.quasi);
      case "BinaryExpression": {
        if (node.operator !== "+") return null;
        const left = fold(node.left);
        const right = fold(node.right);
        return left || right ? cross(left ?? [HOLE], right ?? [HOLE]) : null;
      }
      case "ConditionalExpression":
      case "LogicalExpression": {
        const a = fold(node.type === "LogicalExpression" ? node.left : node.consequent);
        const b = fold(node.type === "LogicalExpression" ? node.right : node.alternate);
        return a || b ? [...(a ?? [HOLE]), ...(b ?? [HOLE])].slice(0, MAX_ALTERNATIVES) : null;
      }
      case "SequenceExpression":
        return fold(node.expressions?.at(-1));
      case "ArrayExpression": {
        const combos = items(node);
        // Joined as words; a multi-part machine token (`ne_radi`, `NOT_FOUND`)
        // is one value of a list, not a word of a sentence.
        const word = (i: string): string => (/[._-]|^[A-Z0-9]+$/u.test(i) && isToken(i) ? HOLE : i);
        return combos ? combos.flatMap((list) => [list.join(""), list.map(word).join(" ")]) : null;
      }
      case "CallExpression":
        return call(node);
      case "Identifier": {
        const init = resolve(node);
        return init ? fold(init) : null;
      }
      default:
        return WRAPPERS.has(node.type) ? fold(node.expression) : null;
    }
  }
  return fold;
}

/** One code of String.fromCharCode: a number, `+n`, `-n` or a numeric string. */
function code(node: Loose | undefined): number | null {
  if (!node) return null;
  if (node.type === "UnaryExpression" && (node.operator === "+" || node.operator === "-"))
    return code(node.argument as Loose);
  if (node.type !== "Literal") return null;
  const n = typeof node.value === "string" ? Number(node.value) : node.value;
  return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The text of `String.fromCharCode(...)` or `String.fromCodePoint(...)`, also
 * with spread arrays and through `.apply(x, [...])` and `.call(x, ...)`.
 */
function charCodes(node: Loose, fold: (n: Loose) => string[] | null): string | null {
  let callee = node.callee;
  let args = node.arguments ?? [];
  const via = memberName(callee, fold);
  if ((via === "apply" || via === "call") && callee?.object?.type === "MemberExpression") {
    callee = callee.object;
    args =
      via === "apply" ? (args[1]?.elements?.filter((e): e is Loose => !!e) ?? []) : args.slice(1);
  }
  if (callee?.type !== "MemberExpression" || callee.object?.name !== "String") return null;
  const key = memberName(callee, fold);
  if (key !== "fromCharCode" && key !== "fromCodePoint") return null;
  const flat = args.flatMap((a) =>
    a.type === "SpreadElement" ? ((a.argument as Loose).elements ?? []) : [a],
  );
  const codes = flat.map((a) => code(a ?? undefined));
  if (codes.length === 0 || !codes.every((c): c is number => c !== null)) return null;
  try {
    return key === "fromCharCode" ? String.fromCharCode(...codes) : String.fromCodePoint(...codes);
  } catch {
    return null;
  }
}

function relative(context: Rule.RuleContext): string {
  return posix.normalize(posix.relative(context.cwd, context.filename.replaceAll("\\", "/")));
}

/**
 * Not an exception class but a debt with an end: the transitional skeleton
 * app still writes Croatian text and is on CRITICAL_PATHS
 * (scripts/engineering/risk-floor.ts), which this standard task does not
 * change. It leaves the list with the task that replaces it (server.ts and
 * server/http, docs/server-map.md, "Prelazno stanje");
 * tests/lint/hardcoded-text.test.ts fails on an entry whose file no longer
 * writes text or no longer exists. Open question on Ductus#1836.
 */
export const TEXT_TRANSITIONAL: readonly string[] = ["server/app.ts"];

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
    const resolve: Resolve = (id) => {
      let scope: Scope.Scope | null = context.sourceCode.getScope(id as unknown as Node);
      for (; scope; scope = scope.upper) {
        const variable = scope.set.get(id.name ?? "");
        if (!variable) continue;
        const def = variable.defs[0];
        const decl = def?.parent as { kind?: string } | undefined | null;
        if (variable.defs.length !== 1 || def?.type !== "Variable" || decl?.kind !== "const")
          return null;
        return (def.node as unknown as { init?: Loose | null }).init ?? null;
      }
      return null;
    };
    const fold = makeFold(resolve);
    const reported = new Set<Loose>();
    function report(node: Node, problem: "letter" | "sentence", text: string): void {
      reported.add(node as unknown as Loose);
      context.report({ node, messageId: problem, data: { text: JSON.stringify(text) } });
    }
    function check(node: Node): void {
      const loose = node as unknown as Loose;
      if (loose.type === "Literal" && loose.regex) return;
      // Report a text once, at the outermost node that shows it.
      for (let up = loose.parent; up; up = up.parent) if (reported.has(up)) return;
      const texts = fold(loose);
      if (!texts) return;
      const raw =
        loose.type === "TemplateLiteral"
          ? [(loose.quasis ?? []).map((q) => q.value.raw).join(HOLE)]
          : [];
      for (const text of [...texts, ...raw]) {
        for (const reading of [text, ...decodings(text)]) {
          const problem = textProblem(reading);
          if (problem) return report(node, problem, reading);
        }
      }
    }
    function name(node: Node): void {
      const id = (node as unknown as Loose).name ?? "";
      if (NON_ASCII_LETTER.test(id)) report(node, "letter", id);
    }
    function regexSource(node: Node): void {
      const loose = node as unknown as Loose;
      const regex = loose.object?.regex as { pattern?: string } | undefined;
      if (!regex?.pattern || memberName(loose, fold) !== "source") return;
      const problem = textProblem(regex.pattern.replace(/\\(.)/gu, "$1"));
      if (problem) report(node, problem, regex.pattern);
    }
    function source(node: Node): void {
      const spec = fold((node as unknown as Loose).source)?.[0];
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
      ConditionalExpression(node) {
        check(node);
      },
      LogicalExpression(node) {
        check(node);
      },
      TaggedTemplateExpression(node) {
        check(node);
      },
      MemberExpression(node) {
        regexSource(node);
      },
      Identifier(node) {
        name(node);
      },
      PrivateIdentifier(node) {
        name(node);
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

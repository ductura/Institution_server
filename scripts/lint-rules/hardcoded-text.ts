// No interface text is written in server code (S-1L.2, DAN-780). Server code
// returns a key (`messageKey`, docs/CODE_STYLE.md §8); the text is in
// locales/. The rule reads only what stands in the source and never works out
// what a piece of code would build (orchestrator decision Ductus#87
// c.6896146643): no constant resolution, no `.join`, no spread, no length cap.
//
// 1. Direct literals: a string literal, each static piece of a template, a JSX
//    text and a name (identifier) are interface text when they
//    hold a letter outside ASCII or a Croatian sentence (textProblem, the
//    measure of ductura/server#51). Only literal text is read: encoded forms
//    (`\\u010d` as text, `%C4%8D`, `&#269;`, `data:`, punycode) are DAN-784
//    (Ductus#87 c.6897002897 and the orchestrator's second cut on #64).
// 2. Text builders are not allowed, whatever their arguments: `\u`, `\x` and
//    `\u{}` escapes that give a non-ASCII character; the names in BUILDER_NAMES
//    wherever they stand (a reference, a member, a key, an import, a
//    destructuring) and in any string that contains them; `String` as a value
//    other than `String(x)`, `new String(x)` and a static member read (so an
//    alias, `globalThis.String`, a computed member or `Reflect.get(String, …)`
//    fail); `String.raw`. Buffer builders (`Buffer.from`, `alloc`, `concat`,
//    `fill`, `write` and every way to reach Buffer) are DAN-784 (orchestrator
//    cut on #65, c.6899577620).
// 3. Exceptions: tests and fixtures (TEXT_EXEMPT), the transitional
//    TEXT_TRANSITIONAL, and DECODER_ALLOWED, the closed list of files that
//    decode input at run time (a request body, a path segment, a signature).
//    In those files a listed decoder may not take a literal argument.
//
// What lint cannot see, left to review and to DAN-782: text built at run time
// from numbers or bytes (`buf.toString()` of a computed array, a lookup through
// a computed key, `.source` of a regex fed to a decoder), and English sentences.
import { posix, win32 } from "node:path";
import type { Rule, Scope } from "eslint";

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
  expression?: Loose;
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

/** Names that build or decode text from codes, bytes or an encoding. */
export const BUILDER_NAMES: readonly string[] = [
  ...["fromCharCode", "fromCodePoint", "atob", "TextDecoder", "StringDecoder"],
  ...["decodeURIComponent", "decodeURI", "unescape", "TextDecoderStream", "domainToUnicode"],
  // Locale data of the runtime (Intl, toLocale*) is Croatian text too.
  ...["Intl", "toLocaleString", "toLocaleDateString", "toLocaleTimeString"],
];
// One regex for every builder name as a whole word, built once (lint time).
const BUILDER_WORD = new RegExp(`\\b(${BUILDER_NAMES.join("|")})\\b`, "u");
// Modules whose default or namespace binding may only be read by a static member.
const NAMESPACE_MODULES = ["node:util", "node:url", "node:string_decoder"];
// Constructors whose `.text()` decodes bytes given to them.
const BYTE_HOLDERS = ["Response", "Blob", "File"];
/** Members of String that are builders. */
const STRING_BUILDERS = new Set(["raw", "fromCharCode", "fromCodePoint"]);
// Names under which the global object is reachable.
const GLOBAL_HOLDERS = ["globalThis", "global", "window", "self"];
// Nodes that wrap an expression without changing its value: `x!`, `x as T`,
// `x satisfies T`, `<T>x`, `f<T>` and an optional chain. Parentheses are no
// node in ESTree, so they are already transparent.
const WRAPPERS = new Set([
  ...["TSNonNullExpression", "TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"],
  ...["TSInstantiationExpression", "ChainExpression"],
]);
/**
 * The expression under every wrapper, nested (`(f! as F)!` is `f`). The one
 * place the rule sees through wrappers, for a callee, an argument, a member
 * key and the shape around a name (review FAIL c.6900338168 on #65).
 */
function unwrap<T extends Loose | undefined>(node: T): T {
  let n: Loose | undefined = node;
  while (n && WRAPPERS.has(n.type)) n = n.expression;
  return n as T;
}
// `typeof x` in a type reads no value.
function inTypeQuery(node: Loose): boolean {
  for (let up = node.parent; up; up = up.parent) if (up.type === "TSTypeQuery") return true;
  return false;
}
// The outermost wrapper around a node, or the node itself: a parent wraps it
// exactly when unwrapping both gives the same node.
function outer(node: Loose): Loose {
  let n = node;
  while (n.parent && unwrap(n.parent) === unwrap(node)) n = n.parent;
  return n;
}
// Array methods that may take String as their callback (`xs.map(String)`).
const CALLBACK_METHODS = ["map", "filter", "some", "every", "find", "findIndex", "flatMap"];
/**
 * Files that decode input at run time, each with the builders it may use. A closed list:
 * tests/lint/hardcoded-text.test.ts checks each entry is used. Contract
 * Ductus#1836 c.6896182732.
 */
export const DECODER_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // Request bodies and path segments.
  "server/session/backchannel.ts": ["TextDecoder"],
  "server/session/return-to.ts": ["decodeURIComponent"],
  "server/contracts/work-id.ts": ["decodeURIComponent"],
  // Link targets in the repository's Markdown (a docs check, S-0.x).
  "server/docs-links.ts": ["decodeURI"],
  "server/domain/document/snapshot.ts": ["TextDecoder"],
  // Storage answers and checksums.
  "server/external/storage/s3-evidence-payload-store.ts": ["TextDecoder"],
  // Evidence formats: UTF-8 payloads and base64url signatures.
  "server/domain/forensics/evidence-chain-v2.ts": ["TextDecoder"],
  "server/domain/forensics/evidence-timing-v1.ts": ["TextDecoder"],
  "server/domain/forensics/evidence-receipt-verifier.ts": ["atob"],
  "server/domain/forensics/submission-receipt-verifier-v2.ts": ["atob"],
  // The contract fake server reads request bodies and paths (test code, U8).
  "server/contracts/generated/fake-server/index.ts": ["TextDecoder", "decodeURIComponent"],
};

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

// A binding only declared for the type checker is still the real global.
function isAmbient(variable: Scope.Variable): boolean {
  return variable.defs.every((def) => {
    for (let node = def.node as Loose | undefined; node; node = node.parent) {
      if (node.declare === true) return true;
      if (node.type === "TSModuleDeclaration" && node.kind === "global") return true;
    }
    return false;
  });
}

// The static name of a member: `a.b`, `a["b"]` or a template with no
// expression; null for a computed key the rule does not read.
function memberName(member: Loose): string | null {
  if (!member.computed) return member.property?.name ?? null;
  const key = unwrap(member.property);
  if (key?.type === "Literal" && typeof key.value === "string") return key.value;
  if (key?.type === "TemplateLiteral" && key.expressions?.length === 0)
    return ((key as { quasis?: { value: { cooked?: string | null } }[] }).quasis?.[0]?.value
      .cooked ?? null) as string | null;
  return null;
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
      builder: "'{{name}}' builds text from codes or bytes; it is not allowed in server code.",
      value:
        "'{{name}}' may only be called or read by a static member here ({{name}}(x), {{name}}.member).",
      exempt: "Server code may not import '{{spec}}': it is a test or fixture (TEXT_EXEMPT).",
    },
  },
  create(context) {
    const file = repoPath(context.cwd, context.filename);
    const allowed = DECODER_ALLOWED[file] ?? [];

    function checkText(node: Node, text: string, raw: string): void {
      const problem = textProblem(text);
      if (problem) {
        context.report({ node, messageId: problem, data: { text: JSON.stringify(text) } });
      }
      // An escape is a builder whatever the character it gives is.
      if (escapedCodes(raw).some((code) => code > 0x7f))
        context.report({ node, messageId: "builder", data: { name: "\\u escape" } });
      const name = BUILDER_WORD.exec(text)?.[1];
      if (name) context.report({ node, messageId: "builder", data: { name } });
    }

    // Whether an argument can be a non-empty literal: through TypeScript
    // wrappers (`as`, `satisfies`, `!`, `<T>`), a sequence, `?:`, `??`/`||`/`&&`
    // and `+` (review FAIL c.6900113231 on #65: `"%C4%91" as const`). A literal
    // inside a call or member (`x.replaceAll("-", "+")`) is not the argument.
    function literalLeaf(node?: Loose): boolean {
      const n = unwrap(node) as
        | (Loose & {
            left?: Loose;
            right?: Loose;
            consequent?: Loose;
            alternate?: Loose;
            quasis?: unknown[];
          })
        | undefined;
      if (!n) return false;
      // A non-empty string or a regex; `null` as the `this` of `.call` is no text.
      if (n.type === "Literal")
        return (typeof n.value === "string" && n.value !== "") || "regex" in n;
      // A template is a literal when a static piece has text or an expression
      // is one (`${x}` is input, `${"%C4%91"}` is not).
      if (n.type === "TemplateLiteral")
        return (
          ((n.quasis ?? []) as { value: { cooked?: string | null } }[]).some(
            (q) => (q.value.cooked ?? "") !== "",
          ) || (n.expressions ?? []).some(literalLeaf)
        );
      if (n.type === "SequenceExpression") return literalLeaf(n.expressions?.at(-1));
      if (n.type === "ConditionalExpression")
        return literalLeaf(n.consequent) || literalLeaf(n.alternate);
      if (n.type === "LogicalExpression" || n.type === "BinaryExpression")
        return literalLeaf(n.left) || literalLeaf(n.right);
      return false;
    }

    // A listed builder in a DECODER_ALLOWED file, unless it is called with a
    // literal first argument (that would be text in another form).
    function allowedUse(node: Loose, name: string): boolean {
      if (!allowed.includes(name)) return false;
      // The argument of `new TextDecoder(…)` is an encoding name.
      if (name === "TextDecoder") return true;
      // `decodeURIComponent!(…)`, `(decodeURIComponent as F)(…)`: the callee is
      // wrapped (review FAIL c.6900338168 on #65).
      let callee = outer(node);
      if (callee.parent?.type === "MemberExpression" && callee.parent.object === callee)
        callee = outer(callee.parent);
      const call = callee.parent;
      const isCall =
        (call?.type === "CallExpression" || call?.type === "NewExpression") &&
        call.callee === callee;
      return !(isCall && literalLeaf(call.arguments?.[0]));
    }

    function checkName(node: Node): void {
      const id = node as unknown as Loose;
      const name = id.name ?? "";
      if (NON_ASCII_LETTER.test(name)) {
        context.report({ node, messageId: "letter", data: { text: JSON.stringify(name) } });
      }
      if (!BUILDER_NAMES.includes(name)) return;
      const parent = id.parent;
      // `globalThis.atob(x)` and `util.TextDecoder` read as the name.
      const target = parent?.type === "MemberExpression" && parent.property === id ? parent : id;
      if (!allowedUse(target, name)) context.report({ node, messageId: "builder", data: { name } });
    }

    // A value use of String: a call, `new`, or a static member read.
    function checkValue(node: Loose, name: string): void {
      if (inTypeQuery(node)) return;
      // `String!(x)` and `(String as S).raw` read through the wrapper.
      const self = outer(node);
      const parent = self.parent;
      if (
        (parent?.type === "CallExpression" || parent?.type === "NewExpression") &&
        parent.callee === self &&
        name === "String"
      )
        return;
      // `.map(String)`: only the first argument of an array method, the callback.
      // A `thisArg` and every other argument are values (review FAIL
      // c.6900113231 on #65, orchestrator order c.6900141699).
      const callee = unwrap(parent?.callee);
      const method = callee?.type === "MemberExpression" ? memberName(callee) : null;
      if (
        parent?.type === "CallExpression" &&
        name === "String" &&
        parent.arguments?.[0] === self &&
        method !== null &&
        CALLBACK_METHODS.includes(method)
      )
        return;
      if (parent?.type !== "MemberExpression" || parent.object !== self) {
        if (parent?.type !== "TSQualifiedName")
          context.report({ node: node as Node, messageId: "value", data: { name } });
        return;
      }
      const member = memberName(parent);
      // `String.prototype` only as the object of a further static member.
      const read = outer(parent);
      const next = read.parent;
      const prototypeLeak =
        member === "prototype" &&
        !(next?.type === "MemberExpression" && next.object === read && memberName(next) !== null);
      if (member === null || STRING_BUILDERS.has(member) || prototypeLeak) {
        const shown = `${name}.${member ?? "[computed]"}`;
        context.report({ node: parent as Node, messageId: "builder", data: { name: shown } });
        return;
      }
    }

    function checkSource(node: Node, source: Loose | null | undefined): void {
      const spec = typeof source?.value === "string" ? source.value : "";
      if (!spec.startsWith(".")) return;
      if (isExempt(posix.normalize(posix.join(posix.dirname(file), spec))))
        context.report({ node, messageId: "exempt", data: { spec } });
    }

    return {
      "Program:exit"() {
        const manager = context.sourceCode.scopeManager;
        const globalScope = manager?.globalScope;
        if (!manager || !globalScope) return;
        const values = ["String"];
        for (const reference of globalScope.through) {
          const id = reference.identifier as unknown as Loose;
          const typeOnly = (reference as { isValueReference?: boolean }).isValueReference === false;
          if (!typeOnly && values.includes(id.name ?? "")) checkValue(id, id.name ?? "");
        }
        for (const scope of manager.scopes) {
          for (const variable of scope.variables) {
            if (!values.includes(variable.name)) continue;
            if (scope !== globalScope && !isAmbient(variable)) continue;
            for (const reference of variable.references) {
              if ((reference as { isValueReference?: boolean }).isValueReference === false)
                continue;
              checkValue(reference.identifier as unknown as Loose, variable.name);
            }
          }
        }
      },
      // `globalThis.String` and the like; `Type.String()` of a schema library is not the global.
      MemberExpression(node) {
        const member = node as unknown as Loose;
        const name = memberName(member);
        const object = unwrap(member.object);
        const holder = object?.type === "Identifier" ? (object.name ?? "") : "";
        if (name === "String" && GLOBAL_HOLDERS.includes(holder))
          context.report({ node, messageId: "value", data: { name } });
      },
      "Identifier, PrivateIdentifier, JSXIdentifier": checkName,
      // `new Response(bytes).text()`: bytes written in the source.
      NewExpression(node) {
        const call = node as unknown as Loose;
        const first = unwrap(call.arguments?.[0]);
        const callee = unwrap(call.callee);
        const holder = callee?.type === "Identifier" ? (callee.name ?? "") : "";
        const bytes = first?.type === "ArrayExpression" || first?.type === "NewExpression";
        if (BYTE_HOLDERS.includes(holder) && bytes)
          context.report({ node, messageId: "builder", data: { name: holder } });
      },
      // The default or namespace binding of a module with decoders.
      "ImportDefaultSpecifier, ImportNamespaceSpecifier"(node: Node) {
        const spec = String((node as unknown as Loose).parent?.source?.value ?? "");
        const name = spec.startsWith("node:") ? spec : `node:${spec}`;
        if (!NAMESPACE_MODULES.includes(name)) return;
        for (const variable of context.sourceCode.getDeclaredVariables(node)) {
          for (const reference of variable.references) {
            const id = reference.identifier as unknown as Loose;
            if (inTypeQuery(id)) continue;
            const self = outer(id);
            const up = self.parent;
            const read = up?.type === "MemberExpression" && up.object === self && !up.computed;
            if (!read)
              context.report({ node: id as Node, messageId: "value", data: { name: spec } });
          }
        }
      },
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
        if (typeof literal.value === "string") checkText(node, literal.value, literal.raw ?? "");
        // A regex pattern is text through `.source`: letters as \\u escapes.
        const pattern = (literal as { regex?: { pattern: string } }).regex?.pattern;
        const problem = pattern === undefined ? null : textProblem(pattern);
        if (problem)
          context.report({ node, messageId: problem, data: { text: JSON.stringify(pattern) } });
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw, node.value.raw);
      },
      JSXText(node: Node) {
        const text = String((node as unknown as Loose).value ?? "");
        checkText(node, text, text);
      },
      ImportDeclaration: (node) => checkSource(node, node.source as Loose),
      ExportNamedDeclaration: (node) => checkSource(node, node.source as Loose | null),
      ExportAllDeclaration: (node) => checkSource(node, node.source as Loose),
      ImportExpression: (node) => checkSource(node, node.source as Loose),
    };
  },
};

import { dirname, isAbsolute, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { AST, Rule } from "eslint";

import { specifierVisitors } from "./database-boundary.ts";

type Node = Rule.Node;
type Literal = { type: string; value?: unknown; expressions?: unknown[]; quasis?: unknown[] };
type Loose = { type?: string; expression?: unknown };

// The generated fake server folder of the contracts (U8), however the path
// reaches it: either slash, unnormalized segments, a query or fragment suffix,
// a .js or no extension, and any letter case (Windows and macOS load
// ./Generated/Fake-Server/index.ts as the same file).
const FAKE_SERVER_RE = /(?:^|\/)generated\/fake-server(?:$|[/?#.])/iu;
// Test code, by its path from the repository root: the folders and suffixes of
// TEST_ONLY_FILES in eslint.config.ts. It may import the fake server, so a
// re-export there would carry it into production code.
export const TEST_ONLY_RE =
  /^(?:test-support|server\/test-server|packages\/test-fakes)(?:\/|$)|\.test\.[cm]?[jt]s$/iu;
// The test fakes package (U9) by name, with or without a subpath, any case.
const TEST_FAKES_PACKAGE_RE = /^@ductura\/test-fakes(?:$|[/?#])/iu;
// A name of a fake (DAN-950): Fake or fake before the end, an uppercase letter,
// a digit, _ or $ (FakeEmail, fakeClock, Fake2), or FAKE before the end, a digit
// or _ (FAKE_KEY). faker, FAKER, Fakery and isFake are not.
const FAKE_NAME_RE = /^(?:[Ff]ake(?=$|[A-Z0-9_$])|FAKE(?=$|[0-9_]))/u;
// `/// <reference path="..." />` and `/// <reference types="..." />`.
const REFERENCE_RE = /^\/\s*<reference\s+(?:path|types)\s*=\s*["']([^"']*)["']/u;

// The forms a specifier can take for the same file: as written, trimmed, with
// either slash, normalized, and with %-escapes decoded (Node decodes them in a
// relative ESM specifier).
function spellings(specifier: string): string[] {
  const slashed = specifier.trim().replace(/\\/g, "/");
  let decoded = slashed;
  try {
    decoded = decodeURIComponent(slashed);
  } catch {
    // An invalid escape loads nothing; the other spellings are still tested.
  }
  return [...new Set([specifier, slashed, decoded])].flatMap((text) => [
    text,
    posix.normalize(text),
  ]);
}

// The file a specifier names, read from `from`, when it is a path: relative,
// absolute or a file: URL. A package name or node: builtin gives undefined.
function target(text: string, from: string): string | undefined {
  if (/^file:/iu.test(text)) {
    try {
      return fileURLToPath(text).replace(/\\/g, "/");
    } catch {
      return undefined;
    }
  }
  if (/^\.\.?(?:\/|$)/u.test(text)) return posix.join(dirname(from).replace(/\\/g, "/"), text);
  return isAbsolute(text) || text.startsWith("/") ? text : undefined;
}

/**
 * True when a module specifier, read from the file `from`, names the fake
 * server or a file in its folder. A relative specifier is also resolved against
 * the importing file, so `./fake-server/index.ts` from generated/ is caught.
 */
export function isFakeServer(specifier: string, from: string): boolean {
  return spellings(specifier).some((text) => {
    const resolved = target(text, from);
    return FAKE_SERVER_RE.test(text) || (resolved !== undefined && FAKE_SERVER_RE.test(resolved));
  });
}

/**
 * True when a specifier, read from `from` in the repository at `root`, names
 * test code: test-support/, server/test-server/, packages/test-fakes/ (also
 * as the package @ductura/test-fakes) or a *.test.ts file. Such a module may
 * re-export the fake server, so production code does not load it.
 */
export function isTestCode(specifier: string, from: string, root: string): boolean {
  return spellings(specifier).some((text) => {
    if (TEST_FAKES_PACKAGE_RE.test(text)) return true;
    const resolved = target(text, from);
    if (resolved === undefined) return false;
    const path = relative(root, resolved).replace(/\\/g, "/");
    return !path.startsWith("../") && TEST_ONLY_RE.test(path);
  });
}

function literalText(node: Literal | null | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0) {
    const [quasi] = node.quasis as { value: { cooked?: string | null } }[];
    return quasi?.value.cooked ?? undefined;
  }
  return undefined;
}

// Runs every listener of each set for the same node type.
function merged(...sets: Rule.RuleListener[]): Rule.RuleListener {
  const out: Record<string, (node: never) => void> = {};
  for (const set of sets) {
    for (const [key, listener] of Object.entries(set) as [string, (node: never) => void][]) {
      const before = out[key];
      out[key] = before
        ? (node) => {
            before(node);
            listener(node);
          }
        : listener;
    }
  }
  return out as Rule.RuleListener;
}

/**
 * The contract fake server answers with made-up vectors and is for tests only.
 * Reports it in every form a file can name a module with: import and
 * `import type`, `export … from`, import(), require and the other loader calls
 * of database-boundary.ts, `import x = require(…)` (TSExternalModuleReference),
 * `typeof import(…)` (TSImportType) and a `/// <reference>` comment, by the
 * specifier as written and resolved. It also reports production code that
 * loads test code, through which a re-export would reach the fake server.
 * eslint.config.ts switches the rule off only for test files, server/test-server,
 * test-support and packages/test-fakes; no other block turns it off.
 */
export const noFakeServerImport: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "The contract fake server is imported only by test code" },
    schema: [],
    messages: {
      fakeServer: "The contract fake server is for tests only.",
      testCode: "Test code is imported only by tests; it may re-export the contract fake server.",
      fakeName: "'{{name}}' names a fake; production code imports and exports no fakes (DAN-950).",
    },
  },
  create(context) {
    const from = context.filename;
    const fake = (specifier: string): boolean => isFakeServer(specifier, from);
    const test = (specifier: string): boolean => isTestCode(specifier, from, context.cwd);
    const check = (where: { node: Node } | { loc: AST.SourceLocation }, specifier?: string) => {
      if (specifier === undefined) return;
      if (fake(specifier)) context.report({ ...where, messageId: "fakeServer" });
      else if (test(specifier)) context.report({ ...where, messageId: "testCode" });
    };
    // Every name an import or export binds, as written (an identifier or a string).
    const nameOf = (node: unknown): string | undefined => {
      const named = node as { type?: string; name?: unknown; value?: unknown } | null | undefined;
      if (named?.type === "Identifier") return String(named.name);
      return named?.type === "Literal" && typeof named.value === "string" ? named.value : undefined;
    };
    // fakeName, unless the declaration's own module is already reported.
    const fakeNames = (node: Node, source: unknown, names: unknown[]) => {
      const specifier = literalText(source as Literal | undefined);
      if (specifier !== undefined && (fake(specifier) || test(specifier))) return;
      const found = new Set(names.map(nameOf).filter((name) => name && FAKE_NAME_RE.test(name)));
      for (const name of found) context.report({ node, messageId: "fakeName", data: { name } });
    };
    // Every segment of `N.M.y` in `import X = N.M.y` (review FAIL c.6954717628).
    const qualifiedNames = (reference: unknown): unknown[] => {
      const name = reference as { type?: string; left?: unknown; right?: unknown } | undefined;
      if (name?.type === "TSQualifiedName") return [...qualifiedNames(name.left), name.right];
      return name?.type === "Identifier" ? [name] : [];
    };
    type Specifier = { local?: unknown; imported?: unknown; exported?: unknown };
    const bindings = (specifiers: Specifier[] | undefined): unknown[] =>
      (specifiers ?? []).flatMap((s) => [s.local, s.imported, s.exported]);
    return merged(
      {
        ImportDeclaration(node: Node & { source?: unknown; specifiers?: Specifier[] }) {
          fakeNames(node, node.source, bindings(node.specifiers));
        },
        ExportNamedDeclaration(node: Node & { source?: unknown; specifiers?: Specifier[] }) {
          fakeNames(node, node.source, bindings(node.specifiers));
        },
        ExportAllDeclaration(node: Node & { source?: unknown; exported?: unknown }) {
          fakeNames(node, node.source, [node.exported]);
        },
        TSImportEqualsDeclaration(node: Node & { id?: unknown; moduleReference?: Loose }) {
          const reference = node.moduleReference;
          const source =
            reference?.type === "TSExternalModuleReference" ? reference.expression : undefined;
          fakeNames(node, source, [node.id, ...qualifiedNames(reference)]);
        },
      } as Rule.RuleListener,
      specifierVisitors(context, fake, "fakeServer"),
      specifierVisitors(context, (s) => !fake(s) && test(s), "testCode"),
      {
        TSImportType(node: Node & { source?: Literal }) {
          check({ node }, literalText(node.source));
        },
        TSExternalModuleReference(node: Node & { expression?: Literal }) {
          check({ node }, literalText(node.expression));
        },
        Program() {
          for (const comment of context.sourceCode.getAllComments()) {
            const match = comment.type === "Line" ? REFERENCE_RE.exec(comment.value) : null;
            if (match && comment.loc) check({ loc: comment.loc }, match[1]);
          }
        },
      } as Rule.RuleListener,
    );
  },
};

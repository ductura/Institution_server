// No production code in server/ loads a module other than by a static import
// (S-1A-c, DAN-770; docs/server-map.md §2). An allow-list, not a list of
// bypasses: every value reference to a global that can load or run code is
// reported unless the file and the exact `name.member` are listed in
// DYNAMIC_LOAD_ALLOWED, and a static import must name a relative file inside
// server/, a listed node: module or a package from `dependencies`. An alias, a
// destructuring or a computed key is therefore not a `name.member` and fails
// with no rule of its own. Test files (*.test.ts) are not linted by this rule:
// production code cannot import them (local/no-fake-server-import, testCode),
// and tests/lint/dynamic-load.test.ts checks both sets cover all of server/.
//
// The keys of FORBIDDEN_KEYS (the Function constructor, a native engine
// loader) fail as a member, a destructured or imported name, and inside any
// string literal or template piece, whatever its parent, so Reflect.get(fn,
// "constructor") fails too. What the rule cannot see: a key built at run time
// ("constr" + "uctor", fn[k] with k from a join, a lookup by descriptor value)
// and the internals of dependencies. Both need a runtime guard, not lint:
// DAN-772 (--disallow-code-generation-from-strings). Every name an export
// statement exposes is a key of the module namespace, so exportedNames()
// collects them all in one place (declarations at any pattern depth,
// specifiers, `export * as`, `export default`, `export =`, `export as
// namespace`; DAN-773) and each is checked against the same list.
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Rule, Scope } from "eslint";

type Node = Rule.Node;
type Loose = {
  type: string;
  name?: string;
  value?: unknown;
  computed?: boolean;
  declare?: boolean;
  kind?: string;
  object?: unknown;
  property?: Loose;
  key?: Loose;
  meta?: Loose;
  parent?: Loose;
  expressions?: unknown[];
  quasis?: { value: { cooked?: string | null } }[];
  source?: Loose | null;
  importKind?: string;
  exportKind?: string;
  moduleReference?: Loose;
  imported?: Loose;
  local?: Loose;
  exported?: Loose;
  callee?: Loose;
  arguments?: unknown[];
  id?: Loose | null;
  init?: unknown;
  left?: Loose;
  right?: Loose;
  argument?: Loose;
  declaration?: Loose | null;
  expression?: Loose;
  declarations?: Loose[];
  specifiers?: Loose[];
  properties?: Loose[];
  elements?: (Loose | null)[];
  consequent?: Loose;
  alternate?: Loose;
  static?: boolean;
  body?: Loose | Loose[];
};

/** Globals that can load a module or run a string as code. */
export const LOADER_GLOBALS: readonly string[] = [
  ...["process", "globalThis", "global", "require", "module", "exports", "eval", "Function"],
];
/** The pseudo-global of MetaProperty `import.meta`. */
export const IMPORT_META = "import.meta";

/**
 * The only files that may use a loader global, each only as `name.member`
 * with the members listed (DAN-770 contract, Ductus#1836 c.6891713609 §2).
 * Keys are exact repository paths; another name or letter case fails.
 */
export const DYNAMIC_LOAD_ALLOWED: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  // The local entry point reads PORT (found by lint, not in the c.6891713609 table).
  "server/index.ts": { process: ["env"] },
  // The entry point reads the environment and sets the exit code (S-1B-a, DAN-775).
  "server/server.ts": { process: ["env", "exitCode"] },
  "server/config/environment.ts": { process: ["env"] },
  "server/database/index.ts": { process: ["env"] },
  "server/database/plain-label-check.ts": {
    process: ["env", "argv", "exitCode"],
    [IMPORT_META]: ["url"],
  },
  "server/external/keys/development-ed25519-signer.ts": { process: ["env"] },
  "server/external/keys/persistent-development-ed25519-signer.ts": { process: ["platform"] },
  "server/external/srce-auth/config.ts": { process: ["env"] },
  "server/external/storage/evidence-storage-config.ts": { process: ["env"] },
  "server/external/storage/s3-evidence-payload-store.ts": {
    process: ["env"],
    globalThis: ["fetch"],
  },
  "server/domain/document/snapshot.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/crypto.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/evidence-chain-v2.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/evidence-checkpoint-v2.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/evidence-log-merkle.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/evidence-receipt.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/evidence-receipt-verifier.ts": {
    globalThis: ["crypto", "structuredClone", "atob", "btoa"],
  },
  "server/domain/forensics/submission-receipt.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/submission-receipt-v2.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/submission-receipt-verifier-v2.ts": { globalThis: ["crypto"] },
  "server/domain/forensics/golden-vectors/load.ts": { [IMPORT_META]: ["url"] },
  "server/contracts/generated/fake-server/index.ts": { [IMPORT_META]: ["url"] },
};

/**
 * Keys that reach a loader from an allowed value: `constructor` gives the
 * Function constructor of any function, and `setEngine` of node:crypto loads a
 * native library.
 */
export const FORBIDDEN_KEYS: readonly string[] = ["constructor", "setEngine"];
/**
 * The only places a forbidden key may stand as a string: an element of the
 * array in `const <binding> = new Set([...])` at the top of the file, with the
 * global Set. Nothing else in that file is exempt (spread, argument, key).
 */
export const KEY_LITERAL_ALLOWED: Readonly<
  Record<string, { readonly binding: string; readonly keys: readonly string[] }>
> = {
  // FORBIDDEN_KEYS of the edit-step validator: keys a payload may not carry.
  "server/domain/document/edit-step.ts": { binding: "FORBIDDEN_KEYS", keys: ["constructor"] },
};

/** node: modules production server code may import, always with the prefix. */
export const NODE_MODULES: readonly string[] = [
  ...["crypto", "fs", "fs/promises", "path", "url", "util", "http", "async_hooks"],
];
// A package subpath: plain segments, no ".", ".." or empty segment.
const SUBPATH_RE = /^[a-z0-9_-]+(?:\/[a-z0-9_-]+)*$/u;

const dependencyCache = new Map<string, readonly string[]>();
/** The `dependencies` of the package.json in `root` (not devDependencies). */
export function runtimeDependencies(root: string): readonly string[] {
  let names = dependencyCache.get(root);
  if (names === undefined) {
    const manifest = JSON.parse(readFileSync(posix.join(root, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    names = Object.keys(manifest.dependencies ?? {});
    dependencyCache.set(root, names);
  }
  return names;
}

// The text of a string literal or of a template without interpolation (a
// key as written; nothing is folded).
function staticText(node: Loose | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions?.length === 0)
    return node.quasis?.[0]?.value.cooked ?? undefined;
  return undefined;
}

// The name of a non-computed key or member, or the text of a static computed one.
function keyName(key: Loose | undefined, computed: boolean | undefined): string | undefined {
  if (!computed) return key?.type === "Identifier" ? key.name : staticText(key);
  return staticText(key);
}

// A binding only declared for the type checker (`declare const require`,
// `declare global { var process }`) is still the real global at run time.
function isAmbient(variable: Scope.Variable): boolean {
  return variable.defs.every((def) => {
    for (let node = def.node as Loose | undefined; node; node = node.parent) {
      if (node.declare === true) return true;
      if (node.type === "TSModuleDeclaration" && node.kind === "global") return true;
    }
    return false;
  });
}

// `typeof x` in a type is erased at emit time and loads nothing.
function inTypeQuery(node: Loose): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "TSTypeQuery") return true;
  }
  return false;
}

// Every identifier a binding pattern declares, through nested object and
// array patterns, default values and rest elements (`export const { a: [b =
// 1, ...c], ...d } = …`). Keys of an object pattern are checked as Property.
function patternNames(pattern: Loose | null | undefined): Loose[] {
  switch (pattern?.type) {
    case "Identifier":
      return [pattern];
    case "ObjectPattern":
      return (pattern.properties ?? []).flatMap((property) =>
        patternNames(property.type === "RestElement" ? property : (property.value as Loose)),
      );
    case "ArrayPattern":
      return (pattern.elements ?? []).flatMap(patternNames);
    case "AssignmentPattern":
      return patternNames(pattern.left);
    case "RestElement":
      return patternNames(pattern.argument);
    default:
      return [];
  }
}

// Each segment of a declared name (`namespace A.B` declares A and A.B).
function qualifiedNames(id: Loose | null | undefined): Loose[] {
  if (id?.type === "TSQualifiedName")
    return [...qualifiedNames(id.left), ...qualifiedNames(id.right)];
  return id ? [id] : [];
}

// The names a declaration binds: every variable of every declarator, or the
// id of a function, class, enum, interface, type, namespace or
// `import x = …` (an anonymous default declaration binds none).
function declaredNames(declaration: Loose | null | undefined): Loose[] {
  if (!declaration) return [];
  if (declaration.type === "VariableDeclaration")
    return (declaration.declarations ?? []).flatMap((declarator) => patternNames(declarator.id));
  return qualifiedNames(declaration.id);
}

// The expression a type-only wrapper holds (`x as T`, `x satisfies T`,
// `<T>x`, `x!`, `f<T>`); the wrapper is erased and the value is the same.
const TYPE_WRAPPERS = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSInstantiationExpression",
]);
function unwrapped(node: Loose | null | undefined): Loose | null | undefined {
  let value = node;
  while (value && TYPE_WRAPPERS.has(value.type)) value = value.expression;
  return value;
}

// The keys `export = <expression>` gives module.exports, as far as the
// syntax shows them: a name, an object's non-computed keys, a class's name
// and static members, a function's name; through type wrappers, the last
// expression of a sequence and every branch of a condition or `||`/`&&`/`??`.
// A value from elsewhere (`export = o`) is data flow, outside lint.
function assignedNames(node: Loose | null | undefined): Loose[] {
  const value = unwrapped(node);
  switch (value?.type) {
    case "Identifier":
      return [value];
    case "ObjectExpression":
      return (value.properties ?? []).flatMap((property) =>
        property.type === "Property" && !property.computed && property.key ? [property.key] : [],
      );
    case "ClassExpression": {
      const members = (value.body as Loose | undefined)?.body;
      return [
        ...qualifiedNames(value.id),
        ...(Array.isArray(members) ? members : []).flatMap((member) =>
          member.static === true && !member.computed && member.key ? [member.key] : [],
        ),
      ];
    }
    case "SequenceExpression":
      return assignedNames((value.expressions as Loose[] | undefined)?.at(-1));
    case "ConditionalExpression":
      return [...assignedNames(value.consequent), ...assignedNames(value.alternate)];
    case "LogicalExpression":
      return [...assignedNames(value.left), ...assignedNames(value.right)];
    default:
      return declaredNames(value);
  }
}

/**
 * Every name an export statement exposes or binds, in any form the parser
 * accepts (DAN-773): both names of each specifier, the names of an exported
 * declaration, the name of `export * as`, a named or identifier `export
 * default`, `export =` of a name or of an object's keys, `export as
 * namespace`. One list, so that no form needs a check of its own.
 */
export function exportedNames(node: Loose): Loose[] {
  switch (node.type) {
    case "ExportNamedDeclaration":
      return [
        ...declaredNames(node.declaration),
        ...(node.specifiers ?? []).flatMap((specifier) => [
          specifier.local as Loose,
          specifier.exported as Loose,
        ]),
      ];
    case "ExportDefaultDeclaration": {
      // The namespace key is `default`; a forbidden binding behind it fails
      // the same way through any wrapper or sequence.
      let value = unwrapped(node.declaration);
      while (value?.type === "SequenceExpression")
        value = unwrapped((value.expressions as Loose[] | undefined)?.at(-1));
      return value?.type === "Identifier" ? [value] : declaredNames(value);
    }
    case "ExportAllDeclaration":
      return node.exported ? [node.exported] : [];
    case "TSExportAssignment":
      return assignedNames(node.expression);
    case "TSNamespaceExportDeclaration":
      return node.id ? [node.id] : [];
    default:
      return [];
  }
}

export const noDynamicLoad: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Server code loads modules only by a static import (DAN-770)" },
    schema: [],
    messages: {
      global:
        "'{{name}}' is allowed only as {{name}}.<member> in the files of DYNAMIC_LOAD_ALLOWED (DAN-770).",
      dynamicImport: "import() is not allowed in server code; use a static import (DAN-770).",
      importRequire: "`import x = require()` is not allowed in server code (DAN-770).",
      module:
        "'{{spec}}' is not on the allow-list: a relative file in server/, an allowed node: module or a package from dependencies (DAN-770).",
      key: "'{{key}}' reaches a loader (the Function constructor or a native engine) (DAN-770).",
    },
  },
  create(context) {
    const root = context.cwd.replace(/\\/g, "/");
    const file = posix.normalize(posix.relative(root, context.filename.replace(/\\/g, "/")));
    const allowed = DYNAMIC_LOAD_ALLOWED[file] ?? {};
    const dependencies = runtimeDependencies(root);

    // `name.member` with a non-computed member the file is allowed to use.
    function allowedUse(node: Loose, name: string): boolean {
      const parent = node.parent;
      if (parent?.type !== "MemberExpression" || parent.object !== node || parent.computed)
        return false;
      const member = parent.property?.type === "Identifier" ? parent.property.name : undefined;
      return member !== undefined && (allowed[name] ?? []).includes(member);
    }

    function allowedModule(spec: string): boolean {
      if (/^\.\.?\//u.test(spec)) {
        const target = posix.normalize(posix.join(posix.dirname(file), spec));
        return target.startsWith("server/") && !target.split("/").includes("node_modules");
      }
      if (spec.startsWith("node:")) return NODE_MODULES.includes(spec.slice("node:".length));
      return dependencies.some(
        (name) =>
          spec === name ||
          (spec.startsWith(`${name}/`) && SUBPATH_RE.test(spec.slice(name.length + 1))),
      );
    }

    function checkSource(node: Node, source: Loose | null | undefined, kind?: string): void {
      if (!source || kind === "type") return;
      const spec = typeof source.value === "string" ? source.value : "";
      if (!allowedModule(spec)) context.report({ node, messageId: "module", data: { spec } });
    }

    function reportGlobal(node: Loose, name: string): void {
      if (inTypeQuery(node) || allowedUse(node, name)) return;
      context.report({ node: node as Node, messageId: "global", data: { name } });
    }

    function checkKey(node: Node, key: string | undefined): void {
      if (key !== undefined && FORBIDDEN_KEYS.includes(key))
        context.report({ node, messageId: "key", data: { key } });
    }

    // The one check of exported names: every form goes through exportedNames().
    function checkExportedNames(node: Node): void {
      for (const name of exportedNames(node as unknown as Loose))
        checkKey(name as unknown as Node, keyName(name, false));
    }

    // The one data declaration of KEY_LITERAL_ALLOWED: the literal is a direct
    // element of `const <binding> = new Set([...])` at the top level, and Set
    // is the global (not a local class that could run the value).
    function isDataElement(node: Loose): boolean {
      const entry = KEY_LITERAL_ALLOWED[file];
      const array = node.parent;
      const created = array?.parent;
      const declarator = created?.parent;
      const declaration = declarator?.parent;
      return (
        entry !== undefined &&
        array?.type === "ArrayExpression" &&
        created?.type === "NewExpression" &&
        created.callee?.type === "Identifier" &&
        created.callee.name === "Set" &&
        created.arguments?.[0] === array &&
        declarator?.type === "VariableDeclarator" &&
        declarator.id?.type === "Identifier" &&
        declarator.id.name === entry.binding &&
        declarator.init === created &&
        declaration?.type === "VariableDeclaration" &&
        declaration.kind === "const" &&
        declaration.parent?.type === "Program" &&
        context.sourceCode
          .getScope(created as unknown as Node)
          .through.some((reference) => reference.identifier === created.callee)
      );
    }

    // Every string literal and every template piece that contains a forbidden
    // key fails, whatever its parent: no skipping by parent and no folding
    // (orchestrator decision on #45, c.6892342579). Only the direct elements
    // of the data declaration of KEY_LITERAL_ALLOWED are exempt.
    function checkText(node: Node, text: string, exempt: boolean): void {
      const key = FORBIDDEN_KEYS.find((name) => text.includes(name));
      if (key === undefined) return;
      if (exempt && text === key && KEY_LITERAL_ALLOWED[file]?.keys.includes(key) === true) return;
      context.report({ node, messageId: "key", data: { key } });
    }

    return {
      "Program:exit"() {
        const globalScope = context.sourceCode.scopeManager?.globalScope;
        if (!globalScope) return;
        for (const reference of globalScope.through) {
          const id = reference.identifier as Loose;
          if (id.name !== undefined && LOADER_GLOBALS.includes(id.name)) reportGlobal(id, id.name);
        }
        // Declared names: a global from configuration or an ambient declaration.
        for (const scope of context.sourceCode.scopeManager?.scopes ?? []) {
          for (const variable of scope.variables) {
            if (!LOADER_GLOBALS.includes(variable.name)) continue;
            if (scope !== globalScope && !isAmbient(variable)) continue;
            for (const reference of variable.references) {
              reportGlobal(reference.identifier as Loose, variable.name);
            }
          }
        }
      },
      MetaProperty(node) {
        const meta = node as unknown as Loose;
        if (meta.meta?.name === "import" && meta.property?.name === "meta")
          reportGlobal(meta, IMPORT_META);
      },
      ImportExpression: (node) => context.report({ node, messageId: "dynamicImport" }),
      TSImportEqualsDeclaration(node: Node) {
        const reference = (node as unknown as Loose).moduleReference;
        if (reference?.type === "TSExternalModuleReference")
          context.report({ node, messageId: "importRequire" });
      },
      ImportDeclaration: (node) =>
        checkSource(node, node.source as Loose, (node as Loose).importKind),
      ExportNamedDeclaration(node) {
        checkSource(node, node.source as Loose | null, (node as Loose).exportKind);
        checkExportedNames(node);
      },
      ExportAllDeclaration(node) {
        checkSource(node, node.source as Loose, (node as Loose).exportKind);
        checkExportedNames(node);
      },
      "ExportDefaultDeclaration, TSExportAssignment, TSNamespaceExportDeclaration":
        checkExportedNames,
      MemberExpression(node) {
        if (!node.computed) checkKey(node, keyName(node.property as Loose, false));
      },
      Property(node) {
        if ((node as Loose).parent?.type === "ObjectPattern" && !node.computed)
          checkKey(node, keyName(node.key as Loose, false));
      },
      // Both names of an import specifier, as imported and as bound
      // (`import { setEngine as s }`); export specifiers are in exportedNames().
      ImportSpecifier(node) {
        checkKey(node, keyName(node.imported as Loose, false));
        checkKey(node, keyName(node.local as Loose, false));
      },
      ImportDefaultSpecifier: (node) => checkKey(node, keyName(node.local as Loose, false)),
      ImportNamespaceSpecifier: (node) => checkKey(node, keyName(node.local as Loose, false)),
      Literal(node) {
        const literal = node as unknown as Loose;
        if (typeof literal.value === "string")
          checkText(node, literal.value, isDataElement(literal));
      },
      TemplateElement(node) {
        checkText(node, node.value.cooked ?? node.value.raw, false);
      },
    };
  },
};

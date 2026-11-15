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
// loader) fail as a member, a destructured or imported name and as any static
// string, folded across `+` ("constr" + "uctor"), so Reflect.get(fn,
// "constructor") fails too. What the rule cannot see: a key built at run time
// (fn[k] with k from a join, a lookup by descriptor value) and the internals
// of dependencies. Both need a runtime guard, not lint.
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
  operator?: string;
  left?: Loose;
  right?: Loose;
  imported?: Loose;
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
/** The only files that may hold a forbidden key as a string, as data. */
export const KEY_LITERAL_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // FORBIDDEN_KEYS of the edit-step validator: keys a payload may not carry.
  "server/domain/document/edit-step.ts": ["constructor"],
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

// The text of a string literal, or of a template or `+` built only of static
// parts, else undefined.
function staticText(node: Loose | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value;
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    const left = staticText(node.left);
    const right = staticText(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  if (node?.type === "TemplateLiteral") {
    // `constr${"uctor"}`: every interpolation static, joined with the quasis.
    let text = "";
    for (const [index, quasi] of (node.quasis ?? []).entries()) {
      if (typeof quasi.value.cooked !== "string") return undefined;
      text += quasi.value.cooked;
      const expression = node.expressions?.[index] as Loose | undefined;
      if (expression === undefined) continue;
      const part = staticText(expression);
      if (part === undefined) return undefined;
      text += part;
    }
    return text;
  }
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

    // A static string anywhere, reported once at the outermost `+`.
    function checkString(node: Node): void {
      const loose = node as unknown as Loose;
      if (loose.parent?.type === "BinaryExpression" && loose.parent.operator === "+") return;
      const text = staticText(loose);
      if (text !== undefined && !(KEY_LITERAL_ALLOWED[file] ?? []).includes(text))
        checkKey(node, text);
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
      ExportNamedDeclaration: (node) =>
        checkSource(node, node.source as Loose | null, (node as Loose).exportKind),
      ExportAllDeclaration: (node) =>
        checkSource(node, node.source as Loose, (node as Loose).exportKind),
      MemberExpression(node) {
        if (!node.computed) checkKey(node, keyName(node.property as Loose, false));
      },
      Property(node) {
        if ((node as Loose).parent?.type === "ObjectPattern" && !node.computed)
          checkKey(node, keyName(node.key as Loose, false));
      },
      ImportSpecifier: (node) => checkKey(node, keyName(node.imported as Loose, false)),
      ExportSpecifier: (node) => checkKey(node, keyName(node.local as Loose, false)),
      Literal: (node) => checkString(node),
      TemplateLiteral: (node) => checkString(node),
      BinaryExpression: (node) => checkString(node),
    };
  },
};

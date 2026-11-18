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
// loader) fail at the level of a name, not of a syntactic form (DAN-773,
// contract Ductus#1836 c.6894826454): every Identifier, PrivateIdentifier and
// JSXIdentifier with that name fails wherever it stands (a binding, a member,
// a key, an export, an enum member, a namespace, a label, a type), and so does
// any string literal or template piece that contains one, whatever its parent,
// so Reflect.get(fn, "constructor") fails too. The one exception is the key
// `constructor` of a class constructor (MethodDefinition, kind "constructor").
// What the rule cannot see: a key built at run time ("constr" + "uctor", fn[k]
// with k from a join, a lookup by descriptor value) and the internals of
// dependencies. Both need a runtime guard, not lint: DAN-772
// (--disallow-code-generation-from-strings).
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import type { Rule, Scope } from "eslint";
import { isAllowedLocaleImport } from "./area-boundary.ts";

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
  specifiers?: Loose[];
  local?: Loose;
  exportKind?: string;
  moduleReference?: Loose;
  imported?: Loose;
  exported?: Loose;
  callee?: Loose;
  arguments?: unknown[];
  id?: Loose;
  init?: unknown;
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
  // The watch thread of the attempt fence: the monotonic clock, and the kill
  // of its own process (DAN-822-4, Ductus#1836 c.6948159989).
  "server/database/queue/attempt-fence-watch.ts": { process: ["hrtime", "kill", "pid"] },
  // The fence: the same clock, and the URL of the watch next to it (DAN-822-5b1).
  "server/database/queue/attempt-fence.ts": { process: ["hrtime"], [IMPORT_META]: ["url"] },
  // The entry point reads the environment and sets the exit code (S-1B-a, DAN-775).
  // On shutdown it listens to SIGTERM and SIGINT and exits with a code (S-1B-c, DAN-778).
  // The working directory is the repository root the development signer's seed
  // must stay out of, as in Ductus ingest-deps.ts (DAN-815 c).
  "server/server.ts": { process: ["env", "exitCode", "exit", "on", "off", "cwd"] },
  // The logs hook waits for stdout and stderr to drain (S-1B-c, DAN-778).
  "server/http/shutdown.ts": { process: ["stdout", "stderr"] },
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
  // net.Server.close stops listening without ending connections that still
  // write a body (server/http/start.ts, S-1B-c, DAN-778); it loads no code.
  "net",
];
/**
 * node: modules outside NODE_MODULES that one exact file may import, each only
 * as `import { name } from "<spec>"` with the names listed: no alias, no
 * namespace, default or bare import, no `export ... from`, and the name is never
 * exported again. Keys are exact repository paths and full specifiers, read as
 * own properties only (orchestrator decision A on DAN-822, Ductus#1836
 * c.6948159989).
 */
export const NODE_IMPORTS_ALLOWED: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  // The watch thread of the attempt fence takes its shared cell (DAN-822-4).
  "server/database/queue/attempt-fence-watch.ts": { "node:worker_threads": ["workerData"] },
  // The attempt fence starts that thread (DAN-822-5b1), only as WORKER_SCRIPTS_ALLOWED says.
  "server/database/queue/attempt-fence.ts": { "node:worker_threads": ["Worker"] },
};

/**
 * The only scripts a file may start a thread from, as
 * `const thread = new Worker(new URL("<script>", import.meta.url), { workerData })`
 * with the global URL (a conditional of two such URLs is one too), in the body
 * of an exported top-level function the file never names again, the thread
 * used only as `thread.unref()` and `thread.terminate()`. Worker is never a
 * value otherwise, so no eval, other option or code from a string
 * (DAN-822-5b1, decision Ductus#1836 c.6948159989).
 *
 * Known limit (orchestrator cut on #265, c.6962135782): this guards against
 * mistakes, not against code written to get round it (a global overwritten at
 * run time, the module reached under another binding); review is the barrier
 * there. That loading the fence starts no thread is proven at run time by
 * server/database/queue/attempt-fence.test.ts.
 */
export const WORKER_SCRIPTS_ALLOWED: Readonly<Record<string, readonly string[]>> = {
  // The watch from the source tree (.ts) and next to the built bundle (.js).
  "server/database/queue/attempt-fence.ts": [
    "./attempt-fence-watch.ts",
    "./attempt-fence-watch.js",
  ],
};
// What the fence may do with its thread: let the process exit, end it.
const THREAD_METHODS: readonly string[] = ["unref", "terminate"];
// A listed import that may only be a constructor of WORKER_SCRIPTS_ALLOWED.
const WORKER = { spec: "node:worker_threads", name: "Worker" };

// An own property only, so a key of Object.prototype is never an entry.
function own<T>(table: Readonly<Record<string, T>> | undefined, key: string): T | undefined {
  return table !== undefined && Object.hasOwn(table, key) ? table[key] : undefined;
}

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

// `\u{…}` and `\uXXXX` escapes as the characters they stand for.
function decodeUnicodeEscapes(text: string): string {
  return text.replace(/\\u\{([0-9a-fA-F]+)\}|\\u([0-9a-fA-F]{4})/gu, (whole, braced, plain) => {
    const code = Number.parseInt(String(braced ?? plain), 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
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
      worker:
        "Worker is allowed only as const thread = new Worker(new URL(<script of WORKER_SCRIPTS_ALLOWED>, import.meta.url), { workerData }) in an exported function (DAN-822-5b1).",
      nodeExport:
        "A file that imports under NODE_IMPORTS_ALLOWED exports nothing, unless Worker is its only such import (DAN-822-4, DAN-822-5b1).",
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

    function allowedModule(spec: string, node?: Node): boolean {
      if (/^\.\.?\//u.test(spec)) {
        if (node !== undefined && isAllowedLocaleImport(file, node)) return true;
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

    // Local names of the imports NODE_IMPORTS_ALLOWED let through.
    const listedImports = new Set<string>();
    // The specifiers of Worker, which may only construct a listed thread.
    const workerSpecifiers: Node[] = [];

    // `import { name } from "<spec>"`, every name on this file's list for spec.
    function listedImport(node: Node, spec: string): boolean {
      const names = own(own(NODE_IMPORTS_ALLOWED, file), spec);
      const declaration = node as unknown as Loose;
      const specifiers = declaration.specifiers ?? [];
      const ok =
        names !== undefined &&
        declaration.type === "ImportDeclaration" &&
        specifiers.length > 0 &&
        specifiers.every(
          (s) =>
            s.type === "ImportSpecifier" &&
            s.importKind !== "type" &&
            s.imported?.type === "Identifier" &&
            s.local?.name === s.imported.name &&
            names.includes(s.imported.name ?? ""),
        );
      if (ok)
        for (const s of specifiers) {
          if (spec === WORKER.spec && s.imported?.name === WORKER.name)
            workerSpecifiers.push(s as unknown as Node);
          else listedImports.add(s.local?.name ?? "");
        }
      return ok;
    }

    // The global URL: not a binding of this file (a class, an import, a parameter).
    function isGlobalUrl(callee: Loose): boolean {
      if (callee.type !== "Identifier" || callee.name !== "URL") return false;
      const reference = context.sourceCode
        .getScope(callee as unknown as Node)
        .references.find((r) => r.identifier === (callee as unknown));
      return reference !== undefined && (reference.resolved?.defs.length ?? 0) === 0;
    }

    // new URL("<listed script>", import.meta.url), or a conditional of two.
    function isWatchUrl(node: Loose | undefined): boolean {
      const loose = node as (Loose & { consequent?: Loose; alternate?: Loose }) | undefined;
      if (loose?.type === "ConditionalExpression")
        return isWatchUrl(loose.consequent) && isWatchUrl(loose.alternate);
      const [script, base, ...rest] = (loose?.arguments ?? []) as Loose[];
      const meta = base?.object as Loose | undefined;
      return (
        loose?.type === "NewExpression" &&
        loose.callee !== undefined &&
        isGlobalUrl(loose.callee) &&
        rest.length === 0 &&
        script?.type === "Literal" &&
        typeof script.value === "string" &&
        (own(WORKER_SCRIPTS_ALLOWED, file) ?? []).includes(script.value) &&
        base?.type === "MemberExpression" &&
        base.computed === false &&
        base.property?.type === "Identifier" &&
        base.property.name === "url" &&
        meta?.type === "MetaProperty" &&
        meta.meta?.name === "import" &&
        meta.property?.name === "meta"
      );
    }

    // `{ workerData: ... }` and nothing else: no eval, other option, spread or accessor.
    function isWorkerOptions(node: Loose | undefined): boolean {
      const properties = (node as { properties?: Loose[] } | undefined)?.properties ?? [];
      const [only] = properties;
      return (
        node?.type === "ObjectExpression" &&
        properties.length === 1 &&
        only?.type === "Property" &&
        only.kind === "init" &&
        only.computed !== true &&
        (only as { method?: boolean }).method !== true &&
        only.key?.type === "Identifier" &&
        only.key.name === "workerData"
      );
    }

    // The thread starts only when another module calls the function: its
    // const is a statement of the body of `export function name()` at the top
    // of the file, and the file never names that function again (no call,
    // alias, IIFE, block, static block or nested function runs it on import;
    // review FAIL on #265, c.6952102045).
    function inExportedStarter(declaration: Loose): boolean {
      const body = declaration.parent;
      const fn = body?.parent;
      const exported = fn?.parent;
      return (
        body?.type === "BlockStatement" &&
        fn?.type === "FunctionDeclaration" &&
        (fn as { body?: unknown }).body === body &&
        fn.id?.type === "Identifier" &&
        exported?.type === "ExportNamedDeclaration" &&
        exported.parent?.type === "Program" &&
        // The function's own name only: its parameters are declared by it too.
        context.sourceCode
          .getDeclaredVariables(fn as unknown as Node)
          .filter((variable) => variable.name === fn.id?.name)
          .every((variable) => variable.references.length === 0)
      );
    }

    // The thread's const is used only as `t.unref()` or `t.terminate()`: never
    // returned, aliased, passed, stored or read otherwise (Codex P2 on #265).
    function threadStaysInside(declarator: Node): boolean {
      return context.sourceCode.getDeclaredVariables(declarator).every((variable) =>
        variable.references.every((reference) => {
          if (reference.init === true) return true;
          const member = (reference.identifier as Loose).parent;
          const call = member?.parent;
          return (
            member?.type === "MemberExpression" &&
            member.object === (reference.identifier as unknown) &&
            member.computed === false &&
            (member as { optional?: boolean }).optional !== true &&
            member.property?.type === "Identifier" &&
            THREAD_METHODS.includes(member.property.name ?? "") &&
            call?.type === "CallExpression" &&
            call.callee === member &&
            (call as { optional?: boolean }).optional !== true
          );
        }),
      );
    }

    // Every value use of Worker is the constructor of a listed thread.
    function checkWorker(): void {
      for (const specifier of workerSpecifiers) {
        for (const variable of context.sourceCode.getDeclaredVariables(specifier)) {
          for (const reference of variable.references) {
            if ((reference as { isValueReference?: boolean }).isValueReference === false) continue;
            // `typeof Worker` in a type is erased and starts nothing.
            if (inTypeQuery(reference.identifier as Loose)) continue;
            const id = reference.identifier as Loose;
            const call = id.parent;
            const [url, options, ...rest] = (call?.arguments ?? []) as Loose[];
            const declarator = call?.parent;
            const declaration = declarator?.parent;
            const ok =
              call?.type === "NewExpression" &&
              call.callee === id &&
              rest.length === 0 &&
              isWatchUrl(url) &&
              isWorkerOptions(options) &&
              declarator?.type === "VariableDeclarator" &&
              declarator.init === call &&
              declarator.id?.type === "Identifier" &&
              threadStaysInside(declarator as unknown as Node) &&
              declaration?.type === "VariableDeclaration" &&
              declaration.kind === "const" &&
              inExportedStarter(declaration);
            if (!ok) context.report({ node: id as Node, messageId: "worker" });
          }
        }
      }
    }

    function checkSource(node: Node, source: Loose | null | undefined, kind?: string): void {
      if (!source || kind === "type") return;
      const spec = typeof source.value === "string" ? source.value : "";
      if (!allowedModule(spec, node) && !listedImport(node, spec))
        context.report({ node, messageId: "module", data: { spec } });
    }

    // A file with a listed import exports nothing, so no export, alias,
    // wrapper (`as`, `satisfies`, `!`) or container carries the name out (review
    // and QA FAIL on #258). Checked at the end, so an export above the import counts.
    const exportNodes: Node[] = [];

    function reportGlobal(node: Loose, name: string): void {
      if (inTypeQuery(node) || allowedUse(node, name)) return;
      context.report({ node: node as Node, messageId: "global", data: { name } });
    }

    // A name equal to a forbidden key, except the key of a class constructor.
    function checkName(node: Node): void {
      const name = (node as unknown as Loose).name;
      if (name === undefined || !FORBIDDEN_KEYS.includes(name)) return;
      const parent = (node as unknown as Loose).parent;
      if (
        name === "constructor" &&
        parent?.type === "MethodDefinition" &&
        parent.kind === "constructor" &&
        parent.key === (node as unknown) &&
        parent.computed !== true
      )
        return;
      context.report({ node, messageId: "key", data: { key: name } });
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
        checkWorker();
        if (listedImports.size > 0)
          for (const node of exportNodes) context.report({ node, messageId: "nodeExport" });
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
        // `export import x = n.a` is an export too.
        if ((node as unknown as { isExport?: boolean }).isExport === true) exportNodes.push(node);
      },
      ImportDeclaration: (node) =>
        checkSource(node, node.source as Loose, (node as Loose).importKind),
      ExportNamedDeclaration: (node) => {
        checkSource(node, node.source as Loose | null, (node as Loose).exportKind);
        exportNodes.push(node);
      },
      ExportDefaultDeclaration: (node) => void exportNodes.push(node),
      ExportAllDeclaration: (node) => {
        checkSource(node, node.source as Loose, (node as Loose).exportKind);
        exportNodes.push(node);
      },
      TSExportAssignment: (node: Node) => void exportNodes.push(node),
      // Every name, wherever it stands (DAN-773).
      "Identifier, PrivateIdentifier, JSXIdentifier": checkName,
      Literal(node) {
        const literal = node as unknown as Loose;
        if (typeof literal.value === "string")
          checkText(node, literal.value, isDataElement(literal));
        // A regular expression: its source text and its group names (which may
        // be \u escapes) reach a key at run time (.source, .groups) (DAN-773).
        const pattern = (node as { regex?: { pattern: string } }).regex?.pattern;
        if (pattern !== undefined)
          checkText(node, `${pattern}\0${decodeUnicodeEscapes(pattern)}`, false);
      },
      // The cooked text and the source text (String.raw) of a template piece.
      TemplateElement(node) {
        checkText(node, `${node.value.cooked ?? ""}\0${node.value.raw}`, false);
      },
    };
  },
};

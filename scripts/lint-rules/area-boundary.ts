// Import boundaries between the server areas (docs/PLAN.md §3 "Pravilo
// granica", S-1A-b, DAN-769; docs/server-map.md §2). One table of allowed
// imports, AREA_IMPORTS; server/server-map.test.ts checks that it equals the
// table in docs/server-map.md §2 and has no cycle. Because only edges of that
// acyclic table pass, no cycle between areas can exist in the code (rule 5).
// A dynamic import with a computed source is reported by local/import-boundary.
import { posix } from "node:path";
import type { Rule } from "eslint";

import { isLoaderCall, type Loose, staticSpecifier } from "./database-boundary.ts";

type Node = Rule.Node;

/** docs/server-map.md §2: the areas each area may import. */
export const AREA_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  domain: [],
  contracts: [],
  settings: [],
  config: [],
  log: ["settings"],
  metrics: ["settings"],
  database: ["settings", "log", "metrics", "domain"],
  "external/srce-auth": ["settings", "log", "metrics"],
  "external/storage": ["settings", "log", "metrics", "domain"],
  "external/keys": ["settings", "log", "metrics", "domain"],
  "external/email": ["settings", "log", "metrics"],
  traffic: ["settings", "log", "metrics"],
  session: ["settings", "log", "metrics", "domain", "database", "external/srce-auth"],
  roles: ["settings", "log", "metrics", "domain", "contracts", "database"],
  legal: ["settings", "log", "metrics", "domain", "contracts", "database", "external/email"],
  backup: [
    ...["settings", "log", "metrics", "domain", "contracts", "database"],
    ...["external/storage", "external/keys"],
  ],
  deletion: [
    ...["settings", "log", "metrics", "domain", "contracts", "database"],
    ...["external/storage", "external/email"],
  ],
  downloads: ["settings", "log", "metrics", "domain", "contracts", "database", "external/storage"],
  http: [
    ...["settings", "log", "metrics", "contracts", "traffic", "session", "roles", "legal"],
    ...["backup", "deletion", "downloads", "database", "external/srce-auth"],
    ...["external/storage", "external/keys", "external/email"],
  ],
  "test-server": ["http", "settings"],
};
/** The entry point: files directly in server/ (server.ts; today index.ts and app.ts). */
export const ENTRY = "(entry)";
const ENTRY_IMPORTS: readonly string[] = ["http", "settings", "config"];
/** routes.ts imports only these areas (http only as a type) and its own ./service.ts. */
const ROUTES_IMPORTS: readonly string[] = ["contracts", "http"];
// Packages a production file of domain and contracts may import (rule 2). node:crypto
// in domain is the S-0.19 exception (server/domain/index.test.ts, CODE_PACKAGES).
const PURE_PACKAGES: Readonly<Record<string, RegExp>> = {
  domain: /^node:crypto$/u,
  contracts: /^@sinclair\/typebox(?:$|\/)/u,
};
// Code that only tests run: the golden-vector loader and the contract fake
// server (U8, kept out of production by local/no-fake-server-import).
const PURE_EXEMPT_RE =
  /^server\/(?:domain\/forensics\/golden-vectors\/load\.ts$|contracts\/generated\/fake-server\/)/u;
// Rule 4: nobody imports React, Next.js or a .tsx/.jsx module; PGlite only
// where the database lives (server/database, its tests, the PGlite fake of #35).
const UI_RE =
  /^(?:react|react-dom|next)(?:$|\/)|(?:^|\/)node_modules\/(?:\.pnpm\/)?(?:react|react-dom|next)(?:$|[/@+])|\.[jt]sx$/iu;
const PGLITE_RE =
  /^@electric-sql\/pglite(?:$|\/)|(?:^|\/)node_modules\/(?:\.pnpm\/)?@electric-sql[/+]pglite/iu;
const PGLITE_ALLOWED_RE = /^(?:server\/database|tests\/db|packages\/test-fakes\/pglite)\//u;
// Package self-reference and subpath imports would bypass the relative-path checks.
const ALIAS_RE = /^(?:#|@ductura\/server(?:$|\/))/iu;
// A URL scheme other than node: (data:, file:, http:) loads code past the path checks.
const SCHEME_RE = /^(?!node:)[a-z][a-z0-9+.-]*:/iu;
// Loaders that take a specifier the rule cannot follow once renamed (createRequire
// from node:module) and process members that load a module without an import.
// node:process is also banned: it hands out the same members under any name.
const LOADER_MODULE_RE = /^(?:node:)?(?:module|process)(?:$|\/)/iu;
// Names that load a module wherever they appear: a member, a destructured key,
// an import name or a string key ("getBuiltinModule" in process).
const LOADER_NAMES = new Set(["getBuiltinModule", "mainModule", "dlopen"]);
// Globals that lead to a loader, with the members never allowed on them. eval
// and Function can name any global in a string, so they are not used at all.
const GLOBAL_BANNED = new Set(["process", "global", "globalThis", "eval", "Function"]);
const GLOBAL_MEMBERS_BANNED = new Map<string, ReadonlySet<string>>([
  ["process", new Set([...LOADER_NAMES, "binding"])],
  ["globalThis", GLOBAL_BANNED],
  ["global", GLOBAL_BANNED],
]);
const NEVER_USED_GLOBALS = new Set(["eval", "Function"]);

/** The area of a repository path, ENTRY for server/*.ts, undefined outside server/. */
export function areaOf(path: string): string | undefined {
  const segments = path.split("/");
  if (segments[0]?.toLowerCase() !== "server" || segments.length < 2) return undefined;
  if (segments.length === 2) return ENTRY;
  const first = segments[1]?.toLowerCase() ?? "";
  if (first !== "external") return first;
  return segments.length > 3 ? `external/${segments[2]?.toLowerCase() ?? ""}` : "external";
}

// The forms a specifier takes for the module it loads: either slash, without
// a query or fragment, %-escapes decoded, and without tab, CR and LF (URL
// parsing drops them, so "./\t../x" loads ../x); each read as text and normalized.
function spellings(specifier: string): string[] {
  return [specifier.trim(), specifier.replace(/[\t\n\r]/gu, "").trim()].flatMap((text) => {
    const cut = text.replace(/\\/g, "/").replace(/[?#].*$/su, "");
    let decoded = cut;
    try {
      decoded = decodeURIComponent(cut).replace(/[\t\n\r]/gu, "");
    } catch {
      // An invalid escape loads nothing; the other spellings are still tested.
    }
    return [...new Set([text, cut, decoded, posix.normalize(cut)])];
  });
}

export const areaBoundary: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Server areas import each other only as docs/server-map.md §2 allows" },
    schema: [],
    messages: {
      edge: "Area '{{from}}' may not import '{{to}}' (docs/server-map.md §2).",
      public: "Import area '{{to}}' only through server/{{to}}/index.ts.",
      typeOnly: "Area '{{from}}' imports '{{to}}' only with `import type` or `export type`.",
      pure: "'{{from}}' imports nothing outside itself except its allowed packages (PLAN §3, rule 2).",
      routes: "routes.ts imports only contracts, http (as a type) and its own ./service.ts.",
      ui: "Nothing imports React, Next.js or a .tsx/.jsx module (PLAN §3, rule 4).",
      pglite: "Only server/database imports PGlite (PLAN §3, rule 4).",
      alias: "Import server code by a relative path, not by a package alias.",
      outside: "Server code imports nothing outside server/ by path; use a package.",
      scheme: "Import by path or package name, not by a URL scheme.",
      loader: "Server code does not load modules through node:module or process.",
    },
  },
  create(context) {
    const root = context.cwd.replace(/\\/g, "/");
    const file = posix.normalize(posix.relative(root, context.filename.replace(/\\/g, "/")));
    const dir = posix.dirname(file);
    const fromArea = areaOf(file);
    const known = fromArea === ENTRY || (fromArea !== undefined && fromArea in AREA_IMPORTS);
    const isTest = /\.test\.ts$/iu.test(file);
    const isRoutes = !isTest && posix.basename(file) === "routes.ts";
    const pure =
      !isTest && fromArea !== undefined && fromArea in PURE_PACKAGES && !PURE_EXEMPT_RE.test(file);

    function report(node: Node, messageId: string, to = ""): void {
      context.report({ node, messageId, data: { from: fromArea ?? "", to } });
    }

    // The message for an import of area `to` at `target`, or undefined when it is allowed.
    function crossProblem(target: string, to: string, typeOnly: boolean): string | undefined {
      if (isRoutes) {
        if (!ROUTES_IMPORTS.includes(to) || (to === "http" && !typeOnly)) return "routes";
      } else {
        const row = fromArea === ENTRY ? ENTRY_IMPORTS : (AREA_IMPORTS[fromArea ?? ""] ?? []);
        if (!row.includes(to)) return "edge";
        const adapter = to === "database" || to.startsWith("external/");
        if (adapter && !typeOnly && !isTest && fromArea !== "http" && fromArea !== ENTRY)
          return "typeOnly";
      }
      return target === `server/${to}/index.ts` ? undefined : "public";
    }

    function checkRelative(node: Node, specifier: string, typeOnly: boolean): void {
      for (const text of spellings(specifier)) {
        if (!/^\.\.?(?:\/|$)/u.test(text)) continue;
        // Resolved from the absolute root, so leaving the repository and coming
        // back in ("../../../server/server/x") lands on the same file.
        const target = posix.relative(root, posix.join(root, dir, text));
        const to = target.startsWith("../") ? undefined : areaOf(target);
        if (to === fromArea) {
          if (isRoutes && target !== `${dir}/service.ts`) return report(node, "routes");
          continue;
        }
        if (to === undefined) {
          if (pure) return report(node, "pure");
          if (isRoutes) return report(node, "routes");
          if (!isTest) return report(node, "outside");
          continue;
        }
        // Every spelling must pass: an allowed edge in one does not excuse another
        // ("../settings/\t./../index.ts" is settings as text, server/index.ts to Node).
        const problem = crossProblem(target, to, typeOnly);
        if (problem !== undefined) return report(node, problem, to);
      }
    }

    function check(node: Node, source: unknown, typeOnly: boolean): void {
      const specifier = staticSpecifier(source as Loose | undefined);
      if (specifier === undefined) return;
      const forms = spellings(specifier);
      if (forms.some((text) => UI_RE.test(text))) return report(node, "ui");
      if (forms.some((text) => PGLITE_RE.test(text)) && !PGLITE_ALLOWED_RE.test(file))
        return report(node, "pglite");
      if (!known) return;
      if (/^\.\.?(?:[/\\]|$)/u.test(specifier.trim()))
        return checkRelative(node, specifier, typeOnly);
      if (ALIAS_RE.test(specifier.trim())) return report(node, "alias");
      if (forms.some((text) => SCHEME_RE.test(text))) return report(node, "scheme");
      if (!isTest && forms.some((text) => LOADER_MODULE_RE.test(text)))
        return report(node, "loader");
      if (pure && PURE_PACKAGES[fromArea ?? ""]?.test(specifier) !== true) report(node, "pure");
      else if (isRoutes) report(node, "routes");
    }

    type Kinded = { source?: unknown; importKind?: string; exportKind?: string };
    return {
      ImportDeclaration: (node) => check(node, node.source, (node as Kinded).importKind === "type"),
      ExportNamedDeclaration: (node) =>
        node.source && check(node, node.source, (node as Kinded).exportKind === "type"),
      ExportAllDeclaration: (node) =>
        check(node, node.source, (node as Kinded).exportKind === "type"),
      ImportExpression: (node) => check(node, node.source, false),
      CallExpression(node) {
        if (isLoaderCall(context, node.callee as Loose)) check(node, node.arguments[0], false);
      },
      TSImportType(node: Node & { source?: unknown; argument?: { literal?: unknown } }) {
        check(node, node.source ?? node.argument?.literal, true);
      },
      Identifier(node) {
        if (known && !isTest && LOADER_NAMES.has(node.name)) report(node, "loader");
      },
      Literal(node) {
        const value = (node as { value?: unknown }).value;
        if (known && !isTest && typeof value === "string" && LOADER_NAMES.has(value))
          report(node, "loader");
      },
      TemplateLiteral(node) {
        const [quasi] = node.quasis;
        if (known && !isTest && node.expressions.length === 0 && quasi !== undefined)
          if (LOADER_NAMES.has(quasi.value.cooked ?? "")) report(node, "loader");
      },
      // The globals that reach a module loader (process, globalThis, global) are
      // used only as `name.member`, never as a value, an alias or a computed key;
      // eval and Function, which can name them in a string, not at all.
      "Program:exit"(program) {
        if (!known || isTest) return;
        const scope = context.sourceCode.getScope(program);
        // Built-ins (globalThis, eval, Function) resolve to declared globals;
        // the others (process, global) stay unresolved in `through`.
        const builtins = [...GLOBAL_BANNED].flatMap(
          (name) => scope.set.get(name)?.references ?? [],
        );
        for (const ref of [...scope.through, ...builtins]) {
          const id = ref.identifier as Node & { name: string };
          if (NEVER_USED_GLOBALS.has(id.name)) {
            report(id, "loader");
            continue;
          }
          const banned = GLOBAL_MEMBERS_BANNED.get(id.name);
          if (banned === undefined) continue;
          const parent = id.parent as Loose & { object?: unknown };
          const member =
            parent.type === "MemberExpression" && parent.object === id && parent.computed !== true;
          if (!member || banned.has(parent.property?.name ?? "")) report(id, "loader");
        }
      },
      TSExternalModuleReference(node: Node & { expression?: unknown }) {
        const parent = (node as { parent?: Kinded }).parent;
        check(node, node.expression, parent?.importKind === "type");
      },
    };
  },
};

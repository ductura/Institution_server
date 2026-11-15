// The database driver stays inside server/database (PLAN §3, rule 4; Ductus
// BACKEND 4.3, DAN-50, F-019). Ported from the `database-boundary` plugin and
// the driver patterns of Ductus eslint.config.mjs at d52a92c3 (S-0.17,
// DAN-730) without a change of logic; only the types and the message path
// changed. Ductus also had `db-entry-only` for app/: here
// `local/import-boundary` already keeps every other folder on
// server/database/index.ts.
import { posix } from "node:path";
import type { ESLint, Rule, Scope } from "eslint";

type Node = Rule.Node;
export type Loose = {
  type: string;
  value?: unknown;
  expression?: Loose;
  expressions?: unknown[];
  quasis?: { value: { cooked?: string | null } }[];
  computed?: boolean;
  property?: { name?: string };
  object?: Loose;
  name?: string;
  callee?: Loose;
};

// The database drivers: the pg family by package name (pg, pg/lib/...,
// pg-cursor, pg-boss) and postgres (postgres, postgres/cjs/...), or a static
// path into an installed copy of either (../../node_modules/pg, the pnpm store
// node_modules/.pnpm/pg@x/..., either slash), DAN-50, F-019. Not relative
// paths like ./pg-like, nor other packages (pgx, postgres-array). Both rules
// use this one pattern, case-insensitively.
export const PG_SPECIFIER = String.raw`^(?:pg(?:$|/|-)|postgres(?:$|/))|(?:^|[\\/])node_modules[\\/](?:\.pnpm[\\/])?(?:pg(?:$|[\\/@+-])|postgres(?:$|[\\/@+]))`;
const PG_SPECIFIER_RE = new RegExp(PG_SPECIFIER, "iu");
// A path with an empty, "." or "x/.." segment, or with backslashes, reaches the
// same file (review of #1172): node_modules//pg, node_modules/./pg,
// node_modules/x/../pg. The rule tests the normalized form.
// Only the node_modules part is tested on it: normalizing "./pg-like" gives
// "pg-like", which is not the package.
const PG_PATH_RE = /(?:^|\/)node_modules\/(?:\.pnpm\/)?(?:pg(?:$|[/@+-])|postgres(?:$|[/@+]))/iu;
const normalized = (specifier: string): string => posix.normalize(specifier.replace(/\\/g, "/"));
// A query or fragment suffix ("?", "#") does not change the module that is
// loaded (DAN-448, F-033). Test what comes before the first of them as well as
// the whole text, so the cut only ever adds reports. The trimmed text is tested
// too, because no-restricted-imports trims the source before matching.
const matchesPg = (path: string): boolean =>
  PG_SPECIFIER_RE.test(path) || PG_PATH_RE.test(normalized(path));
const isPg = (specifier: string): boolean =>
  [specifier, specifier.trim()].some(
    (text) => matchesPg(text) || matchesPg(text.replace(/[?#].*$/su, "")),
  );

// The text of a module specifier when it is a literal: a string or a template
// without interpolation, behind type-only TypeScript wrappers that disappear at
// emit time. Only type-only syntax is unwrapped; no remaining runtime
// expression is evaluated, so variables and interpolated templates give
// undefined and are not inspected.
export function staticSpecifier(node: Loose | undefined): string | undefined {
  let source = node;
  while (
    source?.type === "TSAsExpression" ||
    source?.type === "TSTypeAssertion" ||
    source?.type === "TSNonNullExpression" ||
    source?.type === "TSSatisfiesExpression"
  ) {
    source = source.expression;
  }
  if (source?.type === "Literal" && typeof source.value === "string") return source.value;
  if (source?.type === "TemplateLiteral" && source.expressions?.length === 0)
    return source.quasis?.[0]?.value.cooked ?? undefined;
  return undefined;
}

// The binding a name refers to in the scope of node, or undefined.
function binding(
  context: Rule.RuleContext,
  node: Node,
  name: string,
): Scope.Definition | undefined {
  for (
    let scope: Scope.Scope | null = context.sourceCode.getScope(node);
    scope;
    scope = scope.upper
  ) {
    const variable = scope.set.get(name);
    if (variable) return variable.defs[0];
  }
  return undefined;
}

// createRequire from node:module, under any local name, or module.createRequire.
function isCreateRequire(context: Rule.RuleContext, callee: Loose): boolean {
  if (callee.type === "MemberExpression")
    return !callee.computed && callee.property?.name === "createRequire";
  if (callee.type !== "Identifier") return false;
  if (callee.name === "createRequire") return true;
  const def = binding(context, callee as Node, callee.name ?? "");
  return (
    def?.type === "ImportBinding" &&
    (def.node as { imported?: { name?: string } }).imported?.name === "createRequire"
  );
}

// A function that loads a module by specifier: require, module.require,
// createRequire(...) and a name bound to its result.
function isRequire(context: Rule.RuleContext, node: Loose): boolean {
  if (node.type === "CallExpression") return isCreateRequire(context, node.callee as Loose);
  if (node.type === "MemberExpression") {
    return (
      !node.computed &&
      node.object?.type === "Identifier" &&
      node.object.name === "module" &&
      node.property?.name === "require"
    );
  }
  if (node.type !== "Identifier") return false;
  {
    const def = binding(context, node as Node, node.name ?? "");
    if (def === undefined) return node.name === "require";
    const init = (def.node as { init?: Loose | null }).init;
    return (
      def.type === "Variable" &&
      init?.type === "CallExpression" &&
      isCreateRequire(context, init.callee as Loose)
    );
  }
}

// A call that loads or resolves a module: the forms of isRequire, their
// .resolve, and import.meta.resolve.
export function isLoaderCall(context: Rule.RuleContext, callee: Loose): boolean {
  if (isRequire(context, callee)) return true;
  if (callee.type !== "MemberExpression" || callee.computed || callee.property?.name !== "resolve")
    return false;
  return callee.object?.type === "MetaProperty" || isRequire(context, callee.object as Loose);
}

// Report every literal specifier that `test` matches, in the forms a file can
// name a module with: static import and export, import(), and a loader call
// (isLoaderCall) with the specifier as its first argument.
export function specifierVisitors(
  context: Rule.RuleContext,
  test: (specifier: string) => boolean,
  messageId: string,
  { skipStatic }: { skipStatic?: (specifier: unknown) => boolean } = {},
): Rule.RuleListener {
  const check = (node: unknown): void => {
    const specifier = staticSpecifier(node as Loose | undefined);
    if (typeof specifier === "string" && test(specifier))
      context.report({ node: node as Node, messageId });
  };
  const checkStatic = (node: { source?: { value?: unknown } | null | undefined }): void => {
    if (node.source && !skipStatic?.(node.source.value)) check(node.source);
  };
  return {
    ImportExpression(node) {
      check(node.source);
    },
    CallExpression(node) {
      if (isLoaderCall(context, node.callee as Loose)) check(node.arguments[0]);
    },
    ImportDeclaration: (node) => checkStatic(node),
    ExportNamedDeclaration: (node) => checkStatic(node),
    ExportAllDeclaration: (node) => checkStatic(node),
  };
}

/** Dynamic imports, loader calls and unnormalized paths of the driver outside server/database. */
export const noRestrictedDynamicImports: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "The database driver is loaded only in server/database" },
    schema: [],
    messages: {
      restrictedPg: "Database access goes through server/database only.",
    },
  },
  create(context) {
    // Static imports and re-exports: no-restricted-imports matches the
    // trimmed text, so this rule reports only the forms it cannot see,
    // those that are the driver only after normalization.
    return specifierVisitors(context, isPg, "restrictedPg", {
      skipStatic: (specifier) =>
        typeof specifier === "string" && PG_SPECIFIER_RE.test(specifier.trim()),
    });
  },
};

/** Registered under the plugin name `database-boundary`, as in Ductus. */
export const databaseBoundaryPlugin: ESLint.Plugin = {
  meta: { name: "database-boundary" },
  rules: { "no-restricted-dynamic-imports": noRestrictedDynamicImports },
};

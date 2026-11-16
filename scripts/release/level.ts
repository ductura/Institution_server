import ts from "typescript";

import { breakingChanges } from "../../server/contracts/index.ts";

// DAN-804: the semver level of a release, from the staged package of the last
// tag to the staged package of HEAD. Closed by default: whatever cannot be
// classified for sure is major (owner's decision) and any failure is blocked,
// never patch (POTVRDA UGOVORA w804a t. 4).

export type Level = "none" | "patch" | "minor" | "major" | "blocked";
export type Version = readonly [number, number, number];
/** Staged package: path inside the package → file text. */
export type Files = ReadonlyMap<string, string | Uint8Array>;

// Files are compared as raw bytes; only what is parsed (.d.ts, JSON) is decoded,
// strictly and with a BOM kept (orchestrator, 2nd fix round on #92).
const bytes = (c: string | Uint8Array): Buffer =>
  typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c);
const decode = (c: string | Uint8Array): string =>
  typeof c === "string" ? c : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(c);

/** Every identifier token of `text`: a name that appears here may be shadowed. */
function identifierTokens(text: string, into: Set<string>): Set<string> {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
    if (kind === ts.SyntaxKind.Identifier) into.add(scanner.getTokenValue());
  return into;
}

const ORDER: readonly Level[] = ["none", "patch", "minor", "major", "blocked"];
const max = (a: Level, b: Level): Level => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export function parseVersion(text: string): Version | null {
  const m = VERSION.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The highest `<short>-vX.Y.Z` among `tags`; anything else (rc, leading zero) is ignored. */
export function latestTag(tags: readonly string[], short: string): Version | null {
  let best: Version | null = null;
  for (const tag of tags) {
    if (!tag.startsWith(`${short}-v`)) continue;
    const v = parseVersion(tag.slice(short.length + 2));
    if (v && (best === null || compareVersions(v, best) > 0)) best = v;
  }
  return best;
}

/** Why package.json (the floor) does not fit the last tag's major, or null. */
export function floorProblem(base: Version, floor: string): string | null {
  const f = parseVersion(floor);
  if (f === null) return `package.json version ${floor} is not X.Y.Z`;
  if (f[0] > base[0]) return `package.json is on major ${f[0]}; a major awaits the owner's tag`;
  if (f[0] < base[0]) return `package.json major ${f[0]} is below the last tag`;
  return null;
}

/** The version to tag, or a reason why nothing is tagged. */
export function nextVersion(base: Version, level: Level, floor: string): Version | string {
  const problem = floorProblem(base, floor);
  if (problem !== null) return problem;
  const f = parseVersion(floor)!;
  if (level !== "minor" && level !== "patch") return `level ${level}`;
  const next: Version =
    level === "minor" ? [base[0], base[1] + 1, 0] : [base[0], base[1], base[2] + 1];
  return compareVersions(f, next) > 0 ? f : next;
}

// --- declarations -----------------------------------------------------------

type Change = "same" | "optional" | "required" | "changed";
const RANK: readonly Change[] = ["same", "optional", "required", "changed"];
const worst = (a: Change, b: Change): Change => (RANK.indexOf(a) >= RANK.indexOf(b) ? a : b);

const children = (node: ts.Node): ts.Node[] => {
  const out: ts.Node[] = [];
  ts.forEachChild(node, (child) => void out.push(child));
  return out;
};

/**
 * Named nodes by "name#n" (overloads keep their order). The rest by their text
 * at the top of a file, and among members (call, construct and index
 * signatures) by kind and position, so a reordered overload is a change.
 */
function keyed(
  nodes: readonly ts.Node[],
  file: ts.SourceFile,
  ordinal = false,
): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const seen = new Map<string, number>();
  for (const node of nodes) {
    const name = (node as { name?: ts.Node }).name;
    // A variable statement by its variable names (review #92): a generated
    // ROUTE_TABLE with a new route is the same declaration with a new member.
    const base = ts.isVariableStatement(node)
      ? `VariableStatement ${namesOf(node).join(",")}`
      : name
        ? `${ts.SyntaxKind[node.kind]} ${name.getText(file)}`
        : ordinal
          ? ts.SyntaxKind[node.kind]
          : node.getText(file);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.set(`${base}#${n}`, node);
  }
  return out;
}

/**
 * Members of a type literal or interface, by name. Hard cut (orchestrator,
 * #92 c.6906398937): no new member of an existing type is proven safe (keyof,
 * Required, implements, extends, intersections, index signatures), so every
 * new member is "required": major, except a generated contracts type backed
 * by a minor rise of the OpenAPI document (a new route or field).
 */
function members(a: ts.Node, b: ts.Node, fa: ts.SourceFile, fb: ts.SourceFile): Change {
  const ma = keyed((a as ts.TypeLiteralNode).members, fa, true);
  const mb = keyed((b as ts.TypeLiteralNode).members, fb, true);
  let out: Change = "same";
  for (const [key, node] of ma) {
    const other = mb.get(key);
    out = worst(out, other ? compare(node, other, fa, fb) : "changed");
  }
  for (const [key, node] of mb)
    if (!ma.has(key)) out = worst(out, !/#0$/u.test(key) ? "changed" : "required");
  // Everything of an interface besides its members (heritage, type parameters).
  const rest = (n: ts.Node) =>
    children(n).filter((c) => !(n as ts.TypeLiteralNode).members.includes(c as ts.TypeElement));
  return worst(out, list(rest(a), rest(b), fa, fb));
}

/**
 * The tokens of `node` outside its children, without comments or layout: the
 * syntax forEachChild does not visit (`keyof` or `readonly`, `typeof import`,
 * `extends` or `implements`, `const` or `let`).
 */
function skeleton(node: ts.Node, file: ts.SourceFile): string {
  let text = "";
  let pos = node.getStart(file);
  for (const child of children(node)) {
    text += `${file.text.slice(pos, Math.max(pos, child.getStart(file)))} \u0001 `;
    pos = Math.max(pos, child.end);
  }
  text += file.text.slice(pos, node.end);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const tokens: string[] = [];
  // Separators carry no meaning of their own: the children are counted anyway.
  const separators = new Set([ts.SyntaxKind.SemicolonToken, ts.SyntaxKind.CommaToken]);
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan())
    if (!separators.has(kind)) tokens.push(scanner.getTokenText());
  return tokens.join("\u0002");
}

function list(a: ts.Node[], b: ts.Node[], fa: ts.SourceFile, fb: ts.SourceFile): Change {
  if (a.length !== b.length) return "changed";
  return a.reduce<Change>((out, node, i) => worst(out, compare(node, b[i]!, fa, fb)), "same");
}

/** Two declarations, structurally; comments and layout do not count. */
function compare(a: ts.Node, b: ts.Node, fa: ts.SourceFile, fb: ts.SourceFile): Change {
  if (a.kind !== b.kind) return "changed";
  // Members are compared by name; the rest of an interface goes through compare.
  if (ts.isTypeLiteralNode(a) || ts.isInterfaceDeclaration(a)) return members(a, b, fa, fb);
  if (skeleton(a, fa) !== skeleton(b, fb)) return "changed";
  const ca = children(a);
  const cb = children(b);
  if (ca.length === 0 && cb.length === 0)
    return a.getText(fa) === b.getText(fb) ? "same" : "changed";
  return list(ca, cb, fa, fb);
}

/** Top-level declarations of a .d.ts; each name of `export { … }` is its own entry. */
type Declarations = {
  readonly nodes: Map<string, ts.Node>;
  readonly file: ts.SourceFile;
  /** Every declared or exported name; a new entry of one of these merges or shadows. */
  readonly names: Set<string>;
  /** Every identifier the file uses: a new declaration of one shadows a global (review #92). */
  readonly identifiers: Set<string>;
  /** An `export *`: a new local name may shadow one of it. */
  readonly star: boolean;
  /** Empty `export {}` statements: the marker that hides undeclared exports. */
  readonly markers: number;
  /** Triple-slash directives: trivia to the scanner, but they change a client's types. */
  readonly directives: string;
  /** Every module the file refers to (import, export from, import type): one may augment. */
  readonly modules: Set<string>;
};

const nameOf = (node: ts.Node): string | undefined => {
  const name = (node as { name?: ts.Node }).name;
  return name && (ts.isIdentifier(name) || ts.isStringLiteral(name)) ? name.text : undefined;
};

/** The names a top-level node declares; a variable statement names its declarations. */
const namesOf = (node: ts.Node): string[] =>
  ts.isVariableStatement(node)
    ? node.declarationList.declarations.flatMap((d) => nameOf(d) ?? [])
    : [nameOf(node) ?? []].flat();

function declarations(text: string, path: string): Declarations {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics = (file as unknown as { parseDiagnostics: readonly unknown[] })
    .parseDiagnostics;
  if (diagnostics.length > 0) throw new Error(`${path} does not parse`);
  const nodes: ts.Node[] = [];
  const named = new Map<string, ts.Node>();
  let star = false;
  let markers = 0;
  for (const statement of file.statements) {
    const clause = ts.isExportDeclaration(statement) ? statement.exportClause : undefined;
    if (ts.isExportDeclaration(statement) && clause && ts.isNamedExports(clause)) {
      // Import attributes choose the export condition, so they are part of the key.
      const from = `${statement.moduleSpecifier?.getText(file) ?? ""}${statement.attributes ? ` ${statement.attributes.getText(file)}` : ""}`;
      // A value that becomes type-only is gone for JavaScript: the key holds the flag.
      for (const spec of clause.elements) {
        const type = statement.isTypeOnly || spec.isTypeOnly ? "type " : "";
        named.set(`export ${type}${spec.name.text} from ${from}#0`, spec);
      }
      if (clause.elements.length === 0 && !statement.moduleSpecifier) markers += 1;
    } else {
      if (ts.isExportDeclaration(statement) && !clause) star = true;
      nodes.push(statement);
    }
  }
  const names = new Set([...nodes, ...named.values()].flatMap(namesOf));
  const identifiers = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const refs = (list: readonly ts.FileReference[]) =>
    list.map((r) => [r.fileName, r.preserve ?? null, r.resolutionMode ?? null]);
  const directives = JSON.stringify([
    refs(file.referencedFiles),
    refs(file.typeReferenceDirectives),
    refs(file.libReferenceDirectives),
    file.amdDependencies.map((d) => [d.name ?? null, d.path]),
  ]);
  const modules = new Set<string>();
  const visit = (node: ts.Node): void => {
    const target =
      ts.isImportDeclaration(node) || ts.isExportDeclaration(node)
        ? node.moduleSpecifier
        : ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
          ? node.moduleReference.expression
          : ts.isImportTypeNode(node)
            ? node.argument
            : undefined;
    if (target) modules.add(target.getText(file));
    ts.forEachChild(node, visit);
  };
  visit(file);
  return {
    nodes: new Map([...keyed(nodes, file), ...named]),
    file,
    names,
    identifiers,
    star,
    markers,
    directives,
    modules,
  };
}

export type Surface = { readonly level: Change; readonly reasons: string[] };

/** The declaration change from `before` to `after` of one .d.ts. */
export function declarationChange(
  before: string,
  after: string,
  path: string,
  /** Identifier tokens of every old .d.ts of the package. */
  used: ReadonlySet<string> = new Set(),
): Surface {
  const old = declarations(before, path);
  const now = declarations(after, path);
  const [da, fa, db, fb] = [old.nodes, old.file, now.nodes, now.file];
  const reasons: string[] = [];
  let level: Change = "same";
  const note = (key: string, change: Change) => {
    if (change === "same") return;
    level = worst(level, change);
    reasons.push(`${path} ${key.replace(/#0$/u, "")}: ${change}`);
  };
  if (old.directives !== now.directives) note("/// directives", "changed");
  if (old.markers !== now.markers) note("export {}", "changed");
  // A module not referred to before may augment what exists (Codex #92): conservative.
  for (const module of now.modules)
    if (!old.modules.has(module)) note(`new module reference ${module}`, "changed");
  for (const [key, node] of da) {
    const other = db.get(key);
    note(key, other ? compare(node, other, fa, fb) : "changed");
  }
  // A new entry is safe only as a new name: not an overload (#1), not a second
  // block of an existing interface, not `declare global` or `declare module`,
  // not a name the file already used (a global it would shadow, e.g. Date),
  // not next to an `export *` whose names it could shadow, and not an import
  // for its side effects (a module that may augment what exists).
  for (const [key, node] of db)
    if (!da.has(key)) {
      const merges =
        !/#0$/u.test(key) ||
        ts.isModuleDeclaration(node) ||
        // Any new import or `export =`/`export default` may bind a name that
        // shadows a used one (an alias such as `Agent as Date`): self-attack #92.
        ts.isImportDeclaration(node) ||
        ts.isImportEqualsDeclaration(node) ||
        ts.isExportAssignment(node) ||
        now.star ||
        namesOf(node).some(
          (name) => old.names.has(name) || old.identifiers.has(name) || used.has(name),
        );
      note(key, merges ? "changed" : "optional");
    }
  return { level, reasons };
}

// --- package ----------------------------------------------------------------

export type LevelInput = {
  readonly short: "contracts" | "test-fakes";
  readonly before: Files;
  readonly after: Files;
  /** Whether scripts/generate-contracts.ts changed since the tag. */
  readonly generatorChanged: boolean;
};
export type LevelResult = { readonly level: Level; readonly reasons: string[] };

const GENERATED = "server/contracts/generated/";
/** Every declaration file tsc can emit: .d.ts, .d.mts, .d.cts and .d.<ext>.ts. */
const DECLARATION = /\.d\.(?:[mc]?ts|[^/.]+\.ts)$/u;
type Manifest = { version?: unknown; exports?: Record<string, unknown> };

function openapiLevel(before: string, after: string, reasons: string[]): Level {
  const a = JSON.parse(before) as { info?: { version?: unknown } };
  const b = JSON.parse(after) as { info?: { version?: unknown } };
  const problems = breakingChanges(a, b);
  if (problems.length > 0) {
    reasons.push(...problems.map((p) => `openapi ${p}`));
    return "major";
  }
  const va = parseVersion(String(a.info?.version));
  const vb = parseVersion(String(b.info?.version));
  if (!va || !vb) throw new Error("openapi info.version is not X.Y.Z");
  if (vb[0] === va[0] && vb[1] > va[1]) return "minor";
  if (vb[0] === va[0] && vb[1] === va[1] && vb[2] > va[2]) return "patch";
  throw new Error("openapi changed without a minor or patch rise");
}

function packageLevel(input: LevelInput): LevelResult {
  const { before, after } = input;
  const reasons: string[] = [];
  let level: Level = "none";
  const raise = (to: Level, why: string) => {
    level = max(level, to);
    reasons.push(`${to}: ${why}`);
  };
  let api: Level = "none";
  if (input.short === "contracts") {
    const a = before.get("openapi/v1.json");
    const b = after.get("openapi/v1.json");
    if (a === undefined || b === undefined) throw new Error("contracts without openapi/v1.json");
    if (!bytes(a).equals(bytes(b))) api = openapiLevel(decode(a), decode(b), reasons);
    if (api !== "none") raise(api, "openapi/v1.json");
  }
  // A new required member of a generated type (a new route) is backed by the
  // document only when the document grew and the generator stayed the same.
  const backed = api === "minor" && !input.generatorChanged;
  // A new name that appears anywhere in the old declarations may shadow it.
  const used = new Set<string>();
  for (const [path, content] of before)
    if (DECLARATION.test(path)) identifierTokens(decode(content), used);
  for (const path of new Set([...before.keys(), ...after.keys()])) {
    const rawA = before.get(path);
    const rawB = after.get(path);
    if (path === "openapi/v1.json") continue;
    if (rawA !== undefined && rawB !== undefined && bytes(rawA).equals(bytes(rawB))) continue;
    // TypeScript that is not a declaration file is not what tsc publishes: blocked.
    if (/\.[mc]?tsx?$/u.test(path) && !DECLARATION.test(path))
      throw new Error(`${path} is TypeScript but not a declaration file`);
    const parsed = path === "package.json" || DECLARATION.test(path);
    const a = rawA === undefined || !parsed ? undefined : decode(rawA);
    const b = rawB === undefined || !parsed ? undefined : decode(rawB);
    if (!parsed) {
      raise(rawA === undefined ? "patch" : rawB === undefined ? "major" : "patch", path);
      continue;
    }
    if (a === undefined && !DECLARATION.test(path)) raise("patch", `${path} added`);
    else if (b === undefined) raise("major", `${path} removed`);
    else if (path === "package.json") {
      const ma = JSON.parse(a ?? "{}") as Manifest;
      const mb = JSON.parse(b) as Manifest;
      const ea = ma.exports ?? {};
      const eb = mb.exports ?? {};
      for (const key of Object.keys(ea))
        if (JSON.stringify(ea[key]) !== JSON.stringify(eb[key]))
          raise("major", `export ${key} removed or changed`);
      for (const key of Object.keys(eb))
        if (!Object.hasOwn(ea, key)) raise("minor", `export ${key}`);
      // How Node or TypeScript loads the package: any change may break a client.
      for (const key of [
        "type",
        "main",
        "types",
        "typesVersions",
        "imports",
        "peerDependencies",
        "engines",
      ])
        if (
          JSON.stringify((ma as Record<string, unknown>)[key]) !==
          JSON.stringify((mb as Record<string, unknown>)[key])
        )
          raise("major", `package.json ${key}`);
      const rest = (m: Manifest) => JSON.stringify({ ...m, version: null, exports: null });
      if (rest(ma) !== rest(mb)) raise("patch", "package.json");
    } else if (DECLARATION.test(path)) {
      // A new file is read like a new name in an empty one: an augmentation in it is major.
      if (a === undefined) raise("minor", `${path} added`);
      const surface = declarationChange(a ?? "", b, path, used);
      const required = backed && path.startsWith(GENERATED) ? "minor" : "major";
      const to = { same: "patch", optional: "minor", required, changed: "major" } as const;
      raise(to[surface.level], path);
      reasons.push(...surface.reasons);
    } else raise("patch", path);
  }
  return { level, reasons };
}

/** The level of `input`; a failure is blocked, never a lower level. */
export function releaseLevel(input: LevelInput): LevelResult {
  try {
    return packageLevel(input);
  } catch (error) {
    return { level: "blocked", reasons: [`blocked: ${String(error)}`] };
  }
}

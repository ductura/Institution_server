// Finds the changes between two OpenAPI documents of the same major that may break
// a client written against the first one. The guard is closed by default (owner's
// decision for round 3, Ductus#87 c.6880838648): schemas are normalized (sorted keys,
// no annotations) and every remaining difference in an existing route, parameter,
// field, status or header is breaking, except this explicit list of safe changes:
//   - a new route (new path or new method on a path);
//   - a new optional field in a response object;
//   - a new optional field in a request object that was and stays closed
//     (`additionalProperties: false`), so no old request could have carried it;
//   both only where the base schema put no constraint of its own on that name
//   (no matching `patternProperties`, no schema in `additionalProperties` or
//   `unevaluatedProperties`), and only in a positive context: under `not`, `if`,
//   `oneOf` and the like a looser subschema can reject what was accepted. A
//   `oneOf` discriminated in both documents by the same field (discriminator)
//   counts as positive: no value can match two of its branches (DAN-791);
//   - a change of `description`, `example`, `examples` or `title`.
// Nothing is inferred about anyOf, format or bounds: any change there is reported.
type Obj = Record<string, unknown>;
type Direction = "request" | "response";

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const obj = (v: unknown): Obj => (isObj(v) ? v : {});
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
// Only the document's own keys count: "toString" or "__proto__" exist on every object.
const has = (o: Obj, k: string): boolean => Object.hasOwn(o, k);
const own = (o: Obj, k: string): unknown => (has(o, k) ? o[k] : undefined);
const keysOf = (a: Obj, b: Obj): string[] =>
  [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();

// Keywords that only describe; the only keys dropped by normalization.
const ANNOTATIONS = new Set(["description", "example", "examples", "title"]);
const METHODS = new Set(["get", "put", "post", "delete", "options", "head", "patch", "trace"]);
// Schema keywords whose value is one subschema, a map of named subschemas or a list of them.
const SUB_ONE = new Set([
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "items",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
const SUB_MAP = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);
const SUB_LIST = new Set(["allOf", "anyOf", "oneOf", "prefixItems"]);
// Subschemas where accepting more makes the whole schema accept more. Under any other
// keyword (`not`, `if`, `oneOf`, `contains` with maxContains, `$defs` reached by $ref
// from anywhere) a new field is never assumed safe.
const POSITIVE = new Set([
  "additionalItems",
  "additionalProperties",
  "allOf",
  "anyOf",
  "dependentSchemas",
  "else",
  "items",
  "patternProperties",
  "prefixItems",
  "properties",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
]);
// OpenAPI objects whose keys are names (status codes, media types, headers), not keywords.
const NAMED = new Set(["callbacks", "content", "encoding", "headers", "links", "responses"]);

/** JSON with sorted keys, so two equal values give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v))
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

/** A schema with sorted keys and without annotations; field names are never dropped. */
function normalizeSchema(s: unknown): unknown {
  if (!isObj(s)) return s;
  // fromEntries defines own keys, so a field named "__proto__" stays a field.
  return Object.fromEntries(
    Object.keys(s)
      .filter((k) => !ANNOTATIONS.has(k))
      .sort()
      .map((k) => {
        const v = s[k];
        if (SUB_MAP.has(k) && isObj(v))
          return [
            k,
            Object.fromEntries(
              Object.keys(v)
                .sort()
                .map((n) => [n, normalizeSchema(v[n])]),
            ),
          ];
        if (SUB_LIST.has(k) && Array.isArray(v)) return [k, v.map(normalizeSchema)];
        if (SUB_ONE.has(k)) return [k, normalizeSchema(v)];
        return [k, v];
      }),
  );
}

/** Control characters and look-alike spaces as \\uXXXX, so a key cannot forge a CI log line. */
const visible = (s: string): string =>
  s.replace(
    /[\u0000-\u001f\u007f-\u00a0\u2028\u2029]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** Collects findings as "<where> <JSON pointer>: <what>". */
class Report {
  readonly out: string[] = [];
  add(where: string, ptr: readonly string[], what: string): void {
    const pointer = ptr.map((s) => s.replaceAll("~", "~0").replaceAll("/", "~1")).join("/");
    this.out.push(visible(`${where}${pointer ? ` ${pointer}` : ""}: ${what}`));
  }
  same(where: string, ptr: readonly string[], a: unknown, b: unknown): void {
    if (canonical(a) !== canonical(b)) this.add(where, ptr, "changed");
  }
}

/**
 * Two normalized schemas; every difference is reported except a safe new field.
 * `positive` is false once the comparison went under a keyword outside POSITIVE.
 */
function schema(
  r: Report,
  where: string,
  ptr: string[],
  a: unknown,
  b: unknown,
  dir: Direction,
  positive = true,
): void {
  if (!isObj(a) || !isObj(b)) return r.same(where, ptr, a, b);
  for (const k of keysOf(a, b)) {
    const p = [...ptr, k];
    const va = own(a, k);
    const vb = own(b, k);
    const discriminated =
      k === "oneOf" && discriminatorOf(va) !== null && discriminatorOf(va) === discriminatorOf(vb);
    const pos = positive && (POSITIVE.has(k) || discriminated);
    if (k === "properties" && (va === undefined || isObj(va)) && (vb === undefined || isObj(vb))) {
      properties(r, where, p, a, b, dir, pos);
    } else if (va === undefined) r.add(where, p, "added");
    else if (vb === undefined) r.add(where, p, "removed");
    else if (SUB_MAP.has(k) && isObj(va) && isObj(vb)) {
      for (const n of keysOf(va, vb)) {
        if (!has(va, n)) r.add(where, [...p, n], "added");
        else if (!has(vb, n)) r.add(where, [...p, n], "removed");
        else schema(r, where, [...p, n], va[n], vb[n], dir, pos);
      }
    } else if (
      SUB_LIST.has(k) &&
      Array.isArray(va) &&
      Array.isArray(vb) &&
      va.length === vb.length
    ) {
      va.forEach((x, i) => schema(r, where, [...p, String(i)], x, vb[i], dir, pos));
    } else if (SUB_ONE.has(k)) schema(r, where, p, va, vb, dir, pos);
    else r.same(where, p, va, vb);
  }
}

/**
 * The field that tells the branches of a `oneOf` apart, or null when there is
 * none: every branch is `type: "object"`, requires that field and gives it a
 * `const`, and no two branches share the `const`. A value then matches at most
 * one branch whatever fields the branches gain, so the `oneOf` is an `anyOf`.
 * Anything else (`$ref`, `enum`, a field not required) has no discriminator.
 */
export function discriminatorOf(branches: unknown): string | null {
  if (!Array.isArray(branches) || branches.length < 2 || !branches.every(isObj)) return null;
  if (!branches.every((b) => own(b, "type") === "object")) return null;
  const [first, ...rest] = branches.map((b) => new Set(strings(own(b, "required"))));
  const shared = [...(first ?? [])].filter((name) => rest.every((names) => names.has(name)));
  return (
    shared.sort().find((name) => {
      const values = branches.map((b) => own(obj(own(b, "properties")), name));
      if (!values.every((v) => isObj(v) && has(v, "const"))) return false;
      return new Set(values.map((v) => canonical(obj(v).const))).size === branches.length;
    }) ?? null
  );
}

/** True when a pattern in `patternProperties` matches the name; an unreadable one counts. */
function patternHits(s: Obj, name: string): boolean {
  return Object.keys(obj(own(s, "patternProperties"))).some((pattern) => {
    try {
      return new RegExp(pattern, "u").test(name);
    } catch {
      return true;
    }
  });
}

/** True when the schema already constrained `name` before a field of that name existed. */
function constrains(s: Obj, name: string): boolean {
  const extra = own(s, "additionalProperties");
  const rest = own(s, "unevaluatedProperties");
  return (
    patternHits(s, name) ||
    (extra !== undefined && typeof extra !== "boolean") ||
    (extra === undefined && rest !== undefined && rest !== true)
  );
}

function properties(
  r: Report,
  where: string,
  ptr: string[],
  a: Obj,
  b: Obj,
  dir: Direction,
  positive: boolean,
): void {
  const pa = obj(own(a, "properties"));
  const pb = obj(own(b, "properties"));
  const required = strings(own(b, "required"));
  const closed =
    own(a, "additionalProperties") === false && own(b, "additionalProperties") === false;
  for (const n of keysOf(pa, pb)) {
    if (!has(pa, n)) {
      const safe =
        positive && !required.includes(n) && !constrains(a, n) && (dir === "response" || closed);
      if (!safe) r.add(where, [...ptr, n], "field added");
    } else if (!has(pb, n)) r.add(where, [...ptr, n], "field removed");
    else schema(r, where, [...ptr, n], pa[n], pb[n], dir, positive);
  }
}

/** Parameters by "in:name", so their order does not matter. */
function byKey(v: unknown): Map<string, unknown> {
  return new Map(
    (Array.isArray(v) ? v : []).map((p) => [
      isObj(p) && typeof p.in === "string" && typeof p.name === "string"
        ? `${p.in}:${p.name}`
        : canonical(p),
      p,
    ]),
  );
}

/** Two OpenAPI objects (operation, response, media type ...); annotations are skipped. */
function node(
  r: Report,
  where: string,
  ptr: string[],
  a: unknown,
  b: unknown,
  dir: Direction,
  named = false,
): void {
  if (!isObj(a) || !isObj(b)) return r.same(where, ptr, a, b);
  for (const k of keysOf(a, b)) {
    if (!named && ANNOTATIONS.has(k)) continue;
    const p = [...ptr, k];
    const va = own(a, k);
    const vb = own(b, k);
    if (va === undefined) r.add(where, p, "added");
    else if (vb === undefined) r.add(where, p, "removed");
    else if (named) node(r, where, p, va, vb, dir);
    else if (k.startsWith("x-")) r.same(where, p, va, vb);
    else if (k === "schema") schema(r, where, p, normalizeSchema(va), normalizeSchema(vb), dir);
    else if (k === "parameters" && Array.isArray(va) && Array.isArray(vb)) {
      const qa = byKey(va);
      const qb = byKey(vb);
      for (const key of [...new Set([...qa.keys(), ...qb.keys()])].sort()) {
        if (!qa.has(key)) r.add(where, [...p, key], "parameter added");
        else if (!qb.has(key)) r.add(where, [...p, key], "parameter removed");
        else node(r, where, [...p, key], qa.get(key), qb.get(key), "request");
      }
    } else if (NAMED.has(k)) node(r, where, p, va, vb, k === "responses" ? "response" : dir, true);
    else node(r, where, p, va, vb, dir);
  }
}

function paths(r: Report, a: Obj, b: Obj): void {
  for (const path of Object.keys(a).sort()) {
    const ia = obj(a[path]);
    const ib = obj(own(b, path));
    for (const method of Object.keys(ia).sort()) {
      if (!METHODS.has(method)) continue;
      const at = `${method.toUpperCase()} ${path}`;
      if (!has(ib, method)) r.add(at, [], "route removed");
      else node(r, at, [], ia[method], ib[method], "request");
    }
    // Path-level keys (shared parameters, servers); a new method is a new route and safe.
    const rest = (i: Obj) => Object.fromEntries(Object.entries(i).filter(([k]) => !METHODS.has(k)));
    if (has(b, path)) node(r, path, [], rest(ia), rest(ib), "request");
  }
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** major.minor.patch; the first published document had a bare "1", read as 1.0.0. */
function parseVersion(v: unknown, strict: boolean): number[] | null {
  const text = String(v);
  if (!strict && /^\d+$/.test(text)) return [Number(text), 0, 0];
  const m = SEMVER.exec(text);
  return m ? m.slice(1).map(Number) : null;
}

function version(before: Obj, after: Obj, out: string[]): void {
  const raw = obj(after.info).version;
  const a = parseVersion(obj(before.info).version, false);
  const b = parseVersion(raw, true);
  if (!b) return void out.push(`info.version: ${String(raw)} is not major.minor.patch`);
  if (!a)
    return void out.push(
      `info.version: the base version ${String(obj(before.info).version)} is unreadable`,
    );
  if (a[0] !== b[0])
    out.push(`info.version: major changed from ${a[0]} to ${b[0]}; a new major is a new document`);
  const order = b.map((n, i) => n - (a[i] ?? 0)).find((d) => d !== 0) ?? 0;
  const body = (d: Obj) => canonical({ ...d, info: { ...obj(d.info), version: null } });
  if (order < 0) out.push(`info.version: lowered from ${a.join(".")} to ${b.join(".")}`);
  else if (order === 0 && body(before) !== body(after))
    out.push(
      `info.version: the document changed but the version did not rise above ${a.join(".")}`,
    );
}

/** Every change from `before` to `after` that may break a client of `before`; empty when none. */
export function breakingChanges(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  const a = obj(before);
  const b = obj(after);
  version(a, b, out);
  const r = new Report();
  for (const k of keysOf(a, b)) {
    if (k === "paths") paths(r, obj(own(a, k)), obj(own(b, k)));
    else if (k === "info") {
      // The version is judged above; the rest of info is compared like any object.
      const rest = (i: unknown) =>
        Object.fromEntries(Object.entries(obj(i)).filter(([n]) => n !== "version"));
      node(r, "info", [], rest(own(a, k)), rest(own(b, k)), "response");
    } else if (!has(a, k)) r.add(k, [], "added");
    else if (!has(b, k)) r.add(k, [], "removed");
    else r.same(k, [], a[k], b[k]);
  }
  return [...out, ...r.out];
}

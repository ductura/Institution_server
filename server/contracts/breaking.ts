// Finds the changes between two OpenAPI documents of the same major that break
// a client written against the first one. Requests may only widen (accept more),
// success responses may only narrow (promise more). Error answers are not
// compared: a client maps an unknown error code to "unexpected".
type Obj = Record<string, unknown>;
type Direction = "request" | "response";

const obj = (v: unknown): Obj =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Obj) : {};
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** JSON with sorted keys, so two equal schemas give the same text. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Obj)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

/** The alternatives of a schema, nested anyOf/oneOf flattened; null when it has none. */
function variants(s: Obj): Obj[] | null {
  const alts = Array.isArray(s.anyOf) ? s.anyOf : Array.isArray(s.oneOf) ? s.oneOf : null;
  return alts && alts.map(obj).flatMap((a) => variants(a) ?? [a]);
}

function schema(at: string, a: Obj, b: Obj, dir: Direction, out: string[]): void {
  const va = variants(a);
  const vb = variants(b);
  if (va || vb) {
    // A request must still accept every old value; a response may not send a new one.
    const [must, have, word] =
      dir === "request"
        ? [va ?? [a], vb ?? [b], "no longer accepted"]
        : [vb ?? [b], va ?? [a], "new in response"];
    const known = new Set(have.map(canonical));
    for (const v of must) if (!known.has(canonical(v))) out.push(`${at}: ${word} ${canonical(v)}`);
    return;
  }
  if (a.type !== b.type)
    return void out.push(`${at}: type changed from ${String(a.type)} to ${String(b.type)}`);
  const fixed = dir === "request" ? b.const : a.const;
  if (fixed !== undefined && canonical(a.const) !== canonical(b.const))
    return void out.push(`${at}: value changed`);
  if (dir === "request") {
    for (const k of ["maxLength", "maximum", "maxItems", "maxProperties"]) {
      if (typeof b[k] === "number" && !(typeof a[k] === "number" && a[k] <= b[k]))
        out.push(`${at}: ${k} lowered`);
    }
    for (const k of ["minLength", "minimum", "minItems", "minProperties"]) {
      if (typeof b[k] === "number" && !(typeof a[k] === "number" && a[k] >= b[k]))
        out.push(`${at}: ${k} raised`);
    }
    for (const k of ["format", "pattern"])
      if (b[k] !== undefined && b[k] !== a[k]) out.push(`${at}: ${k} changed`);
  }
  if (a.type === "array") schema(`${at}[]`, obj(a.items), obj(b.items), dir, out);
  if (a.type !== "object") return;
  const pa = obj(a.properties);
  const pb = obj(b.properties);
  const ra = new Set(strings(a.required));
  const rb = new Set(strings(b.required));
  for (const [name, s] of Object.entries(pa)) {
    const where = `${at}.${name}`;
    if (!(name in pb)) {
      if (dir === "response") out.push(`${where}: field removed`);
      else if (b.additionalProperties === false) out.push(`${where}: field no longer accepted`);
      continue;
    }
    if (dir === "response" && ra.has(name) && !rb.has(name))
      out.push(`${where}: field became optional`);
    schema(where, obj(s), obj(pb[name]), dir, out);
  }
  if (dir === "request") {
    for (const name of rb) if (!ra.has(name)) out.push(`${at}.${name}: field became required`);
    // An open object accepted any value under a new name; a declared schema may now refuse some.
    if (a.additionalProperties !== false) {
      const extra = a.additionalProperties;
      for (const [name, s] of Object.entries(pb)) {
        if (name in pa) continue;
        if (typeof extra === "object" && extra !== null)
          schema(`${at}.${name}`, obj(extra), obj(s), dir, out);
        else if (canonical(s) !== "{}") out.push(`${at}.${name}: field now constrained`);
      }
    }
    extraFields(at, a.additionalProperties, b.additionalProperties, out);
  }
}

/** A request object's allowance for undeclared fields may widen, never narrow. */
function extraFields(at: string, a: unknown, b: unknown, out: string[]): void {
  if (a === false) return;
  if (b === false) return void out.push(`${at}: extra fields no longer accepted`);
  const isSchema = (v: unknown) => typeof v === "object" && v !== null && canonical(v) !== "{}";
  if (!isSchema(b)) return;
  if (!isSchema(a)) return void out.push(`${at}: extra fields now constrained`);
  schema(`${at}.*`, obj(a), obj(b), "request", out);
}

function parameters(at: string, a: Obj, b: Obj, out: string[]): void {
  const byKey = (op: Obj) =>
    new Map(
      Array.isArray(op.parameters)
        ? op.parameters.map(obj).map((p) => [`${String(p.in)}:${String(p.name)}`, p])
        : [],
    );
  const pa = byKey(a);
  const pb = byKey(b);
  for (const [key, p] of pa) {
    const q = pb.get(key);
    if (!q) out.push(`${at}: parameter ${key} removed`);
    else {
      if (p.required !== true && q.required === true)
        out.push(`${at}: parameter ${key} became required`);
      schema(`${at} parameter ${key}`, obj(p.schema), obj(q.schema), "request", out);
    }
  }
  for (const [key, q] of pb)
    if (!pa.has(key) && q.required === true) out.push(`${at}: new required parameter ${key}`);
}

function requestBody(at: string, a: Obj, b: Obj, out: string[]): void {
  const ca = a.requestBody === undefined ? null : obj(obj(a.requestBody).content);
  const cb = b.requestBody === undefined ? null : obj(obj(b.requestBody).content);
  if (!ca && cb) return void out.push(`${at}: request body added`);
  if (ca && !cb) return void out.push(`${at}: request body removed`);
  if (!ca || !cb) return;
  for (const [type, media] of Object.entries(ca)) {
    if (!(type in cb)) out.push(`${at}: content type ${type} removed`);
    else schema(`${at} body`, obj(obj(media).schema), obj(obj(cb[type]).schema), "request", out);
  }
  const la = a["x-max-body-bytes"];
  const lb = b["x-max-body-bytes"];
  if (typeof lb === "number" && !(typeof la === "number" && la <= lb))
    out.push(`${at}: body limit lowered`);
}

function successResponses(at: string, a: Obj, b: Obj, out: string[]): void {
  const rb = obj(b.responses);
  for (const [status, r] of Object.entries(obj(a.responses))) {
    if (Number(status) >= 400) continue;
    if (!(status in rb)) {
      out.push(`${at}: response ${status} removed`);
      continue;
    }
    const next = obj(rb[status]);
    const ja = obj(obj(r).content)["application/json"];
    const jb = obj(next.content)["application/json"];
    if (ja !== undefined && jb === undefined) out.push(`${at}: response ${status} body removed`);
    else if (ja !== undefined)
      schema(`${at} response ${status}`, obj(obj(ja).schema), obj(obj(jb).schema), "response", out);
    const hb = obj(next.headers);
    for (const h of Object.keys(obj(obj(r).headers)))
      if (!(h in hb)) out.push(`${at}: response ${status} header ${h} removed`);
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

/** Every change from `before` to `after` that breaks a client of `before`; empty when none. */
export function breakingChanges(before: unknown, after: unknown): string[] {
  const out: string[] = [];
  version(obj(before), obj(after), out);
  const next = obj(obj(after).paths);
  for (const [path, ops] of Object.entries(obj(obj(before).paths))) {
    for (const [method, op] of Object.entries(obj(ops))) {
      const at = `${method.toUpperCase()} ${path}`;
      const b = obj(next[path])[method];
      if (b === undefined) {
        out.push(`${at}: route removed`);
        continue;
      }
      const a = obj(op);
      const nb = obj(b);
      if (a.operationId !== nb.operationId) out.push(`${at}: operationId changed`);
      if (a["x-access"] !== nb["x-access"]) out.push(`${at}: access changed`);
      parameters(at, a, nb, out);
      requestBody(at, a, nb, out);
      successResponses(at, a, nb, out);
    }
  }
  return out;
}

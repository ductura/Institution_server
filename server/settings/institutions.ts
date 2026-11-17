// DAN-911-1 (S-M-2; contract Ductus#1836 c.6935252300): the schema check of
// the institutions file, after Ductus src/domain/institution-config/registry.ts
// (parseInstitutionRecords) at b36c82b, in the same order. The citation style
// is checked only by name: the style files do not come to the server. Stricter
// than Ductus: values are read from own property descriptors, so a getter is
// refused without being called. A problem names the place, never the value.
import { INSTITUTIONS_FILE } from "./institutions-file.ts";

export const INSTITUTIONS_FORMAT = "ductus-institutions-v1";
/** The style catalogue of Ductus has one file, whose faculty is fpzg (D-83). */
export const CITATION_STYLES: readonly string[] = ["fpzg"];
/** The `identity.institution.slug` CHECK, matched exactly. */
const SLUG_RE = /^[a-z0-9-]{2,32}$/u;

export type InstitutionRecord = Readonly<{ slug: string; citationStyle: string }>;
export type InstitutionsResult =
  | { readonly ok: true; readonly records: readonly InstitutionRecord[] }
  | { readonly ok: false; readonly problem: string };

class Refused extends Error {}

/** The own data values of a plain object whose own keys are exactly `keys`. */
function exact(value: unknown, keys: readonly string[], path: string): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Refused(`${path} must be an object`);
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) {
    throw new Refused(`${path} must have exactly the fields ${keys.join(", ")}`);
  }
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new Refused(`${path}.${key} is an accessor`);
    }
    values.set(key, descriptor.value);
  }
  return values;
}

function parse(input: unknown): InstitutionRecord[] {
  const root = exact(input, ["format", "institutions"], "institutions file");
  if (root.get("format") !== INSTITUTIONS_FORMAT) {
    throw new Refused("institutions file has an unknown format");
  }
  const list = root.get("institutions");
  if (!Array.isArray(list)) throw new Refused("institutions must be an array");
  const records: InstitutionRecord[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const path = `institutions[${i}]`;
    const item = Object.getOwnPropertyDescriptor(list, i);
    const record = exact(item?.value, ["slug", "citationStyle"], path);
    const slug = record.get("slug");
    const citationStyle = record.get("citationStyle");
    if (typeof slug !== "string" || !SLUG_RE.test(slug))
      throw new Refused(`${path}.slug is malformed`);
    if (seen.has(slug)) throw new Refused(`${path}.slug is a duplicate`);
    if (typeof citationStyle !== "string" || !CITATION_STYLES.includes(citationStyle)) {
      throw new Refused(`${path}.citationStyle is unknown`);
    }
    seen.add(slug);
    records.push(Object.freeze({ slug, citationStyle }));
  }
  return records;
}

/** The records of a valid file, frozen and in file order, or its first problem. */
export function loadInstitutions(input: unknown): InstitutionsResult {
  try {
    return { ok: true, records: Object.freeze(parse(input)) };
  } catch (error) {
    if (error instanceof Refused) return { ok: false, problem: error.message };
    throw error;
  }
}

/** The problem of the institutions file for the startup check; empty when it loads. */
export function institutionsProblems(input: unknown = INSTITUTIONS_FILE): string[] {
  const loaded = loadInstitutions(input);
  return loaded.ok ? [] : [loaded.problem];
}

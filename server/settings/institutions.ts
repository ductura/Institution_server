// DAN-911-1 (S-M-2; contract Ductus#1836 c.6935252300): the schema check of
// the institutions file, after Ductus src/domain/institution-config/registry.ts
// (parseInstitutionRecords) at b36c82b, in the same order. The citation style
// is checked only by name: the style files do not come to the server. Stricter
// than Ductus: values are read from own property descriptors, so a getter is
// refused without being called. A failure is `{ code, messageKey }`
// (docs/CODE_STYLE.md §8, review FAIL c.6935594952), its text in locales/hr.json
// `institutions.*`; it never carries a value of the input.
import { INSTITUTIONS_FILE } from "./institutions-file.ts";

export const INSTITUTIONS_FORMAT = "ductus-institutions-v1";
/**
 * The style IDs of the settings catalogue (`citation.style`, D-83), which stays
 * the source: `server/citation-styles.test.ts` fails when the lists differ.
 */
export const CITATION_STYLES: readonly string[] = [
  "fpzg",
  "apa",
  "chicago",
  "ieee",
  "vancouver",
  "fusnote",
];
/** The `identity.institution.slug` CHECK, matched exactly. */
const SLUG_RE = /^[a-z0-9-]{2,32}$/u;

export const INSTITUTIONS_ERROR_CODES = [
  "INSTITUTIONS_NOT_OBJECT",
  "INSTITUTIONS_FIELDS",
  "INSTITUTIONS_ACCESSOR",
  "INSTITUTIONS_FORMAT",
  "INSTITUTIONS_NOT_ARRAY",
  "INSTITUTION_NOT_OBJECT",
  "INSTITUTION_FIELDS",
  "INSTITUTION_ACCESSOR",
  "INSTITUTION_SLUG_MALFORMED",
  "INSTITUTION_SLUG_DUPLICATE",
  "INSTITUTION_STYLE_UNKNOWN",
] as const;
export type InstitutionsErrorCode = (typeof INSTITUTIONS_ERROR_CODES)[number];

export type InstitutionRecord = Readonly<{ slug: string; citationStyle: string }>;
export type InstitutionsResult =
  | { readonly ok: true; readonly value: readonly InstitutionRecord[] }
  | {
      readonly ok: false;
      readonly error: { readonly code: InstitutionsErrorCode; readonly messageKey: string };
    };

class Refused extends Error {
  readonly code: InstitutionsErrorCode;
  constructor(code: InstitutionsErrorCode) {
    super(code);
    this.code = code;
  }
}

type Codes = Readonly<{
  object: InstitutionsErrorCode;
  fields: InstitutionsErrorCode;
  accessor: InstitutionsErrorCode;
}>;
const ROOT: Codes = {
  object: "INSTITUTIONS_NOT_OBJECT",
  fields: "INSTITUTIONS_FIELDS",
  accessor: "INSTITUTIONS_ACCESSOR",
};
const RECORD: Codes = {
  object: "INSTITUTION_NOT_OBJECT",
  fields: "INSTITUTION_FIELDS",
  accessor: "INSTITUTION_ACCESSOR",
};

/** The own data values of a plain object whose own keys are exactly `keys`. */
function exact(value: unknown, keys: readonly string[], codes: Codes): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Refused(codes.object);
  }
  const own = Reflect.ownKeys(value);
  if (own.length !== keys.length || !keys.every((key) => own.includes(key))) {
    throw new Refused(codes.fields);
  }
  const values = new Map<string, unknown>();
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) throw new Refused(codes.accessor);
    values.set(key, descriptor.value);
  }
  return values;
}

function parse(input: unknown): InstitutionRecord[] {
  const root = exact(input, ["format", "institutions"], ROOT);
  if (root.get("format") !== INSTITUTIONS_FORMAT) throw new Refused("INSTITUTIONS_FORMAT");
  const list = root.get("institutions");
  if (!Array.isArray(list)) throw new Refused("INSTITUTIONS_NOT_ARRAY");
  const records: InstitutionRecord[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const item = Object.getOwnPropertyDescriptor(list, i);
    const record = exact(item?.value, ["slug", "citationStyle"], RECORD);
    const slug = record.get("slug");
    const citationStyle = record.get("citationStyle");
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) {
      throw new Refused("INSTITUTION_SLUG_MALFORMED");
    }
    if (seen.has(slug)) throw new Refused("INSTITUTION_SLUG_DUPLICATE");
    if (typeof citationStyle !== "string" || !CITATION_STYLES.includes(citationStyle)) {
      throw new Refused("INSTITUTION_STYLE_UNKNOWN");
    }
    seen.add(slug);
    records.push(Object.freeze({ slug, citationStyle }));
  }
  return records;
}

/** The records of a valid file, frozen and in file order, or its first error. */
export function loadInstitutions(input: unknown): InstitutionsResult {
  try {
    return { ok: true, value: Object.freeze(parse(input)) };
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    const messageKey = `institutions.${error.code.toLowerCase()}`;
    return { ok: false, error: { code: error.code, messageKey } };
  }
}

/** The startup problem of the institutions file, by its code only; empty when it loads. */
export function institutionsProblems(input: unknown = INSTITUTIONS_FILE): string[] {
  const loaded = loadInstitutions(input);
  return loaded.ok ? [] : [`institutions file is refused: ${loaded.error.code}`];
}

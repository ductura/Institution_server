// DAN-911-1 (S-M-2; contract Ductus#1836 c.6935252300): the institutions file
// and its schema check, after Ductus src/domain/institution-config/registry.ts
// (parseInstitutionRecords) at b36c82b. At most one error, the first in the
// Ductus order, as { code, messageKey } (CODE_STYLE §8); never a value of the input.
import { readFileSync } from "node:fs";

import {
  HOSTILE_JSON,
  HOSTILE_STRINGS,
  hostileObjects,
  hostileStrings,
} from "@ductura/test-fakes/hostile-inputs";
import { describe, expect, it } from "vitest";

import { INSTITUTIONS_FILE } from "./institutions-file.ts";
import {
  INSTITUTIONS_ERROR_CODES,
  institutionsProblems,
  loadInstitutions,
  type InstitutionsErrorCode,
} from "./institutions.ts";

const CANARY = "kanarinac-0911";
const FORMAT = "ductus-institutions-v1";
const file = (...institutions: unknown[]): unknown => ({ format: FORMAT, institutions });
const entry = (slug: unknown, citationStyle: unknown = "fpzg"): unknown => ({
  slug,
  citationStyle,
});
const called = (): never => {
  throw new Error(`getter called ${CANARY}`);
};
const getter = (): unknown => {
  const record = { citationStyle: "fpzg" };
  Object.defineProperty(record, "slug", { enumerable: true, get: called });
  return record;
};

const NO_FORMAT: InstitutionsErrorCode = "INSTITUTIONS_FORMAT";
const ROOT_FIELDS: InstitutionsErrorCode = "INSTITUTIONS_FIELDS";
const RECORD_FIELDS: InstitutionsErrorCode = "INSTITUTION_FIELDS";
const MALFORMED: InstitutionsErrorCode = "INSTITUTION_SLUG_MALFORMED";
const UNKNOWN_STYLE: InstitutionsErrorCode = "INSTITUTION_STYLE_UNKNOWN";
const inherited = (proto: object, own: object): unknown =>
  Object.assign(Object.create(proto) as object, own);
const ownProto = JSON.parse(
  `{"format":"${FORMAT}","institutions":[{"slug":"fpzg","citationStyle":"fpzg","__proto__":"${CANARY}"}]}`,
) as unknown;
// Slugs outside the CHECK: case, space, tab, CRLF, NBSP, DEL, "/", a Windows
// path, 1 and 33 characters, inherited names and a number.
const BAD_SLUGS: unknown[] = ["Fpzg", "fp zg", "fpzg\t", "fpzg\r\n", "fpzg\u00a0", "fpzg\u007f"];
BAD_SLUGS.push("fpzg/a", "C:\\fpzg", "f", "a".repeat(33), "toString", "__proto__", 12);

describe("institutions file schema: refused", () => {
  it.each<[string, unknown, InstitutionsErrorCode]>([
    ["a null root", null, "INSTITUTIONS_NOT_OBJECT"],
    ["an array root", [], "INSTITUTIONS_NOT_OBJECT"],
    ["a string root", CANARY, "INSTITUTIONS_NOT_OBJECT"],
    ["an extra root key", { ...(file() as object), [CANARY]: 1 }, ROOT_FIELDS],
    ["a missing root key", { format: FORMAT }, ROOT_FIELDS],
    ["an inherited root key", inherited({ institutions: [] }, { format: FORMAT }), ROOT_FIELDS],
    ["another format", { format: `${CANARY}-v1`, institutions: [] }, NO_FORMAT],
    ["a format with a space", { format: `${FORMAT} `, institutions: [] }, NO_FORMAT],
    [
      "institutions not an array",
      { format: FORMAT, institutions: { 0: {} } },
      "INSTITUTIONS_NOT_ARRAY",
    ],
    ["a record not an object", file(CANARY), "INSTITUTION_NOT_OBJECT"],
    ["a null record", file(null), "INSTITUTION_NOT_OBJECT"],
    ["an extra field", file({ slug: "fpzg", citationStyle: "fpzg", [CANARY]: 1 }), RECORD_FIELDS],
    ["a missing field", file({ slug: "fpzg" }), RECORD_FIELDS],
    [
      "an inherited slug",
      file(inherited({ slug: "x1" }, { citationStyle: "fpzg" })),
      RECORD_FIELDS,
    ],
    ["__proto__ as an own key", ownProto, RECORD_FIELDS],
    ["a getter slug", file(getter()), "INSTITUTION_ACCESSOR"],
    ...BAD_SLUGS.map((slug): [string, unknown, InstitutionsErrorCode] => [
      `slug ${JSON.stringify(slug)}`,
      file(entry(slug)),
      MALFORMED,
    ]),
    ["a duplicate slug", file(entry("fpzg"), entry("fpzg")), "INSTITUTION_SLUG_DUPLICATE"],
    ...[CANARY, "toString", "__proto__", "constructor", ["fpzg"]].map(
      (style): [string, unknown, InstitutionsErrorCode] => [
        `style ${JSON.stringify(style)}`,
        file(entry("fpzg", style)),
        UNKNOWN_STYLE,
      ],
    ),
    ["two faults, the first wins", file(entry("FPZG", CANARY)), MALFORMED],
  ])("%s", (_, input, code) => {
    const messageKey = `institutions.${code.toLowerCase()}`;
    expect(loadInstitutions(input)).toEqual({ ok: false, error: { code, messageKey } });
    expect(institutionsProblems(input)).toEqual([`institutions file is refused: ${code}`]);
    expect(JSON.stringify(loadInstitutions(input))).not.toContain(CANARY);
  });

  it("refuses an accessor in the root without calling it", () => {
    const root = { institutions: [] };
    Object.defineProperty(root, "format", { enumerable: true, get: called });
    expect(institutionsProblems(root)).toEqual([
      "institutions file is refused: INSTITUTIONS_ACCESSOR",
    ]);
  });

  it("has a Croatian text for every code and no other key", () => {
    const texts = JSON.parse(
      readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
    ) as { institutions: Record<string, string> };
    expect(Object.keys(texts.institutions)).toEqual(
      INSTITUTIONS_ERROR_CODES.map((code) => code.toLowerCase()),
    );
    for (const text of Object.values(texts.institutions)) expect(text.length).toBeGreaterThan(0);
  });
});

describe("institutions file schema: loaded", () => {
  it("the ported file has no problem and loads its three records, frozen", () => {
    expect(institutionsProblems()).toEqual([]);
    const loaded = loadInstitutions(INSTITUTIONS_FILE);
    expect(loaded.ok && loaded.value).toEqual([
      { slug: "fpzg", citationStyle: "fpzg" },
      { slug: "demo-fakultet", citationStyle: "fpzg" },
      { slug: "demo-fakultet-b", citationStyle: "fpzg" },
    ]);
    const records = loaded.ok ? loaded.value : [];
    expect(Object.isFrozen(records)).toBe(true);
    for (const record of records) expect(Object.isFrozen(record)).toBe(true);
  });

  it("an empty list and slugs at both length limits load", () => {
    expect(institutionsProblems(file())).toEqual([]);
    expect(institutionsProblems(file(entry("ab"), entry("a".repeat(32))))).toEqual([]);
  });
});

// DAN-947: the shared hostile inputs of @ductura/test-fakes, in every place of
// the file. Titles name the case only: formatting a getter or a Proxy would touch it.
describe("institutions file schema: hostile inputs", () => {
  const refused = (input: unknown, code: InstitutionsErrorCode): void => {
    const messageKey = `institutions.${code.toLowerCase()}`;
    const result = loadInstitutions(input);
    expect(result.ok ? null : result.error).toStrictEqual({ code, messageKey });
  };
  // The one hostile string inside the slug CHECK loads, as in Ductus and the database.
  const SLUG_CHECKED = ["constructor"];
  const strings = [...HOSTILE_STRINGS, ...hostileStrings("fpzg"), ...hostileStrings(FORMAT)];

  it.each(strings)("the string $name in slug, citationStyle and format", ({ value }) => {
    if (SLUG_CHECKED.includes(value)) {
      expect(loadInstitutions(file(entry(value)))).toStrictEqual({
        ok: true,
        value: [{ slug: value, citationStyle: "fpzg" }],
      });
    } else refused(file(entry(value)), MALFORMED);
    refused(file(entry("fpzg", value)), UNKNOWN_STYLE);
    refused({ format: value, institutions: [] }, NO_FORMAT);
  });

  it.each(HOSTILE_JSON)("the JSON $name as the root and as the list", ({ text }) => {
    const list: unknown = JSON.parse(text);
    refused(list, "INSTITUTIONS_NOT_OBJECT");
    const input = { format: FORMAT, institutions: list };
    if (list === null) refused(input, "INSTITUTIONS_NOT_ARRAY");
    else if (Array.isArray(list) && list.length > 0) refused(input, "INSTITUTION_NOT_OBJECT");
    else expect(loadInstitutions(input)).toStrictEqual({ ok: true, value: [] });
  });

  const CODES = {
    root: { fields: ROOT_FIELDS, accessor: "INSTITUTIONS_ACCESSOR" },
    record: { fields: RECORD_FIELDS, accessor: "INSTITUTION_ACCESSOR" },
  } as const;
  const placed = (at: keyof typeof CODES, valid: Record<string, unknown>) =>
    hostileObjects(valid).map((variant) => ({ ...variant, at }));
  const objects = [
    ...placed("root", { format: FORMAT, institutions: [] }),
    ...placed("record", { slug: "fpzg", citationStyle: "fpzg" }),
  ];

  it.each(objects)("the $at object $name, untouched", ({ at, value, refusal, touched }) => {
    refused(at === "root" ? value : file(value), CODES[at][refusal]);
    expect(touched()).toBe(0);
  });
});

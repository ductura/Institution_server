// DAN-911-1 (S-M-2; contract Ductus#1836 c.6935252300): the institutions file
// and its schema check, after Ductus src/domain/institution-config/registry.ts
// (parseInstitutionRecords) at b36c82b. At most one problem, the first in the
// Ductus order; a problem names the place, never the value.
import { describe, expect, it } from "vitest";

import { INSTITUTIONS_FILE } from "./institutions-file.ts";
import { institutionsProblems, loadInstitutions } from "./institutions.ts";

const CANARY = "kanarinac-0911";
const FORMAT = "ductus-institutions-v1";
const file = (...institutions: unknown[]): unknown => ({ format: FORMAT, institutions });
const entry = (slug: unknown, citationStyle: unknown = "fpzg"): unknown => ({
  slug,
  citationStyle,
});
const getter = (): unknown => {
  const record = { citationStyle: "fpzg" };
  Object.defineProperty(record, "slug", {
    enumerable: true,
    get: () => {
      throw new Error(`getter called ${CANARY}`);
    },
  });
  return record;
};

const NO_FORMAT = "institutions file has an unknown format";
const ROOT_FIELDS = "institutions file must have exactly the fields format, institutions";
const RECORD_FIELDS = "institutions[0] must have exactly the fields slug, citationStyle";
const MALFORMED = "institutions[0].slug is malformed";
const UNKNOWN_STYLE = "institutions[0].citationStyle is unknown";
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
  it.each<[string, unknown, string]>([
    ["a null root", null, "institutions file must be an object"],
    ["an array root", [], "institutions file must be an object"],
    ["a string root", CANARY, "institutions file must be an object"],
    ["an extra root key", { ...(file() as object), [CANARY]: 1 }, ROOT_FIELDS],
    ["a missing root key", { format: FORMAT }, ROOT_FIELDS],
    ["an inherited root key", inherited({ institutions: [] }, { format: FORMAT }), ROOT_FIELDS],
    ["another format", { format: `${CANARY}-v1`, institutions: [] }, NO_FORMAT],
    ["a format with a space", { format: `${FORMAT} `, institutions: [] }, NO_FORMAT],
    [
      "institutions not an array",
      { format: FORMAT, institutions: { 0: {} } },
      "institutions must be an array",
    ],
    ["a record not an object", file(CANARY), "institutions[0] must be an object"],
    ["a null record", file(null), "institutions[0] must be an object"],
    ["an extra field", file({ slug: "fpzg", citationStyle: "fpzg", [CANARY]: 1 }), RECORD_FIELDS],
    ["a missing field", file({ slug: "fpzg" }), RECORD_FIELDS],
    [
      "an inherited slug",
      file(inherited({ slug: "x1" }, { citationStyle: "fpzg" })),
      RECORD_FIELDS,
    ],
    ["__proto__ as an own key", ownProto, RECORD_FIELDS],
    ["a getter slug", file(getter()), "institutions[0].slug is an accessor"],
    ...BAD_SLUGS.map((slug): [string, unknown, string] => [
      `slug ${JSON.stringify(slug)}`,
      file(entry(slug)),
      MALFORMED,
    ]),
    ["a duplicate slug", file(entry("fpzg"), entry("fpzg")), "institutions[1].slug is a duplicate"],
    ...[CANARY, "toString", "__proto__", "constructor", ["fpzg"]].map(
      (style): [string, unknown, string] => [
        `style ${JSON.stringify(style)}`,
        file(entry("fpzg", style)),
        UNKNOWN_STYLE,
      ],
    ),
    ["two faults, the first wins", file(entry("FPZG", CANARY)), MALFORMED],
  ])("%s", (_, input, problem) => {
    expect(institutionsProblems(input)).toEqual([problem]);
    expect(loadInstitutions(input)).toEqual({ ok: false, problem });
    expect(problem).not.toContain(CANARY);
  });
});

describe("institutions file schema: loaded", () => {
  it("the ported file has no problem and loads its three records, frozen", () => {
    expect(institutionsProblems()).toEqual([]);
    const loaded = loadInstitutions(INSTITUTIONS_FILE);
    if (!loaded.ok) throw new Error(loaded.problem);
    expect(loaded.records).toEqual([
      { slug: "fpzg", citationStyle: "fpzg" },
      { slug: "demo-fakultet", citationStyle: "fpzg" },
      { slug: "demo-fakultet-b", citationStyle: "fpzg" },
    ]);
    expect(Object.isFrozen(loaded.records)).toBe(true);
    for (const record of loaded.records) expect(Object.isFrozen(record)).toBe(true);
  });

  it("an empty list and slugs at both length limits load", () => {
    expect(institutionsProblems(file())).toEqual([]);
    expect(institutionsProblems(file(entry("ab"), entry("a".repeat(32))))).toEqual([]);
  });
});

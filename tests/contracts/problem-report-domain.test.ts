// DAN-851-2a3 (contract Ductus#1836 c.6943435196): the problem report domain
// agrees with the support.problem-report.post contract and its vectors. A
// cross-area test, as interface-locale-domain.test.ts: server/contracts and
// server/domain may not import each other (docs/server-map.md §2).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import { validateInput } from "../../server/contracts/generated/index.ts";
import { VECTORS } from "../../server/contracts/generated/fake-server/index.ts";
import {
  BROWSER_FAMILIES,
  PROBLEM_REPORT_CATEGORIES,
  PROBLEM_REPORT_DESCRIPTION_MAX,
  PROBLEM_REPORT_KEYS,
  PROBLEM_REPORT_ROUTES,
  parseProblemReport,
  SYNC_STATES,
} from "../../server/domain/index.ts";

type Schema = {
  readonly const?: unknown;
  readonly type?: unknown;
  readonly anyOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
};

/** Every literal of a schema, walking `anyOf` at any depth. */
const literals = (schema: Schema): unknown[] =>
  schema.anyOf !== undefined
    ? schema.anyOf.flatMap(literals)
    : "const" in schema
      ? [schema.const]
      : [];
/** The non-null branch of a nullable schema. */
const present = (schema: Schema): Schema =>
  schema.anyOf?.find((part) => part.type !== "null") ?? schema;

const ID = "support.problem-report.post";
const contract = ROUTES.find((r) => r.id === ID)!;
const body = contract.request?.body as Schema;
const field = (name: string): Schema => body.properties?.[name] ?? {};
const vectors = VECTORS.filter((v) => v.route === ID);
const named = (name: string) => vectors.find((v) => v.name === name)!;
const sorted = (values: readonly unknown[]) => [...values].map(String).sort();

describe("support.problem-report.post and the problem report domain", () => {
  it("the body has exactly the domain's keys", () => {
    expect(Object.keys(body.properties ?? {}).sort()).toEqual([...PROBLEM_REPORT_KEYS]);
  });

  it("names exactly the domain's closed sets", () => {
    expect(sorted(literals(field("category")))).toEqual(sorted(PROBLEM_REPORT_CATEGORIES));
    expect(sorted(literals(field("browser").properties?.["family"] ?? {}))).toEqual(
      sorted(BROWSER_FAMILIES),
    );
    expect(sorted(literals(field("syncState")))).toEqual(sorted(SYNC_STATES));
  });

  it("has the domain's app version pattern, major range and description length", () => {
    const source = readFileSync(
      new URL("../../server/domain/support/problem-report.ts", import.meta.url),
      "utf8",
    );
    expect(field("appVersion").pattern).toBe(/const APP_VERSION =\s*\/(.*)\/;/.exec(source)?.[1]);
    const major = present(field("browser").properties?.["major"] ?? {});
    expect([major.type, major.minimum, major.maximum]).toEqual(["integer", 0, 999]);
    expect(field("description").pattern).toContain(`{1,${PROBLEM_REPORT_DESCRIPTION_MAX}}`);
  });

  it("allows every domain route by its page pattern, and states how many there are", () => {
    const pattern = new RegExp(present(field("route")).pattern ?? "^$");
    for (const route of PROBLEM_REPORT_ROUTES) expect(route).toMatch(pattern);
    expect(contract.summary).toContain(`closed list of ${PROBLEM_REPORT_ROUTES.length} templates`);
  });

  it("the recorded vectors are reports the domain and the schema accept", () => {
    for (const name of ["recorded", "recorded-without-context"]) {
      const sent = named(name).request.body;
      expect([name, parseProblemReport(sent) !== null]).toEqual([name, true]);
      expect([name, validateInput(ID, "body", sent)]).toEqual([name, true]);
    }
  });

  it("the invalid-input vector is refused by the domain", () => {
    expect(parseProblemReport(named("invalid-input").request.body)).toBeNull();
  });
});

// DAN-909 (S-M-3; contract Ductus#1836 c.6935013407): the work language vectors
// of the contracts pass through the domain parser. A cross-area test, as
// tests/contracts/evidence-domain.test.ts: server/contracts and server/domain
// may not import each other (docs/server-map.md §2).
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import { VECTORS } from "../../server/contracts/generated/fake-server/index.ts";
import { parseWorkLanguage, WORK_LANGUAGES } from "../../server/domain/index.ts";

const ROUTE_IDS = [
  "institution.work-language.post",
  "institution.student-work-language.post",
  "institution.work-work-language.post",
] as const;

type Schema = {
  readonly const?: unknown;
  readonly type?: unknown;
  readonly anyOf?: readonly Schema[];
};

/** Every literal and whether null is allowed, walking `anyOf` at any depth. */
function literals(schema: Schema): { values: unknown[]; nullable: boolean } {
  if (schema.anyOf !== undefined) {
    const parts = schema.anyOf.map(literals);
    return { values: parts.flatMap((p) => p.values), nullable: parts.some((p) => p.nullable) };
  }
  if (schema.type === "null") return { values: [], nullable: true };
  return { values: "const" in schema ? [schema.const] : [], nullable: false };
}

function languageSchema(id: string): { values: unknown[]; nullable: boolean } {
  const route = ROUTES.find((r) => r.id === id);
  const body = route?.request?.body as { properties?: Record<string, Schema> } | undefined;
  const language = body?.properties?.["language"];
  if (language === undefined) throw new Error(`no language in ${id}`);
  return literals(language);
}

const language = (body: unknown): unknown => (body as { language?: unknown } | undefined)?.language;

describe.each(ROUTE_IDS)("%s vectors pass through the work language domain", (id) => {
  const vectors = VECTORS.filter((v) => v.route === id);
  const schema = languageSchema(id);

  it("the contract's languages are WORK_LANGUAGES", () => {
    expect([...schema.values].sort()).toEqual([...WORK_LANGUAGES].sort());
  });

  it("every invalid-input language reads as null", () => {
    const invalid = vectors.filter((v) => v.name === "invalid-input");
    expect(invalid.length).toBeGreaterThan(0);
    for (const v of invalid) expect(parseWorkLanguage(language(v.request.body)), v.name).toBeNull();
  });

  it("every accepted language is a member, or null where the schema allows it", () => {
    const accepted = vectors.filter((v) => v.response.status === 200);
    expect(accepted.length).toBeGreaterThan(0);
    for (const v of accepted) {
      const sent = language(v.request.body);
      if (sent === null) expect(schema.nullable, v.name).toBe(true);
      else expect(parseWorkLanguage(sent), v.name).toBe(sent);
      const answered = language(v.response.body);
      if (id !== "institution.work-language.post")
        expect(parseWorkLanguage(answered), v.name).toBe(answered);
    }
  });
});

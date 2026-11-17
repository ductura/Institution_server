// DAN-851-1a (contract Ductus#1836 c.6935562064): the interface language
// domain agrees with the profile.interface-locale contracts and vectors and with
// the interface catalogues. A cross-area test, as work-language-domain.test.ts:
// server/contracts and server/domain may not import each other, and domain may
// not import locales (docs/server-map.md §2).
import { describe, expect, it } from "vitest";

import { DEFAULT_LANGUAGE, INTERFACE_CATALOGUES, OFFERED_LANGUAGES } from "../../locales/index.ts";
import { ROUTES } from "../../server/contracts/index.ts";
import { VECTORS } from "../../server/contracts/generated/fake-server/index.ts";
import {
  INTERFACE_LOCALE_SETTING_VALUES,
  parseInterfaceLocaleSetting,
} from "../../server/domain/index.ts";

type Schema = {
  readonly const?: unknown;
  readonly type?: unknown;
  readonly anyOf?: readonly Schema[];
  readonly properties?: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: unknown;
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

function route(id: string) {
  const found = ROUTES.find((r) => r.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
}

const postBody = route("profile.interface-locale.post").request?.body as Schema;
const getBody = route("profile.interface-locale.get").responses[0]?.body as Schema;
const localeOf = (body: unknown): unknown => (body as { locale?: unknown } | undefined)?.locale;
const SET = [...INTERFACE_LOCALE_SETTING_VALUES].sort();
const vectorsOf = (id: string) => VECTORS.filter((v) => v.route === id);

describe("profile.interface-locale contracts and the interface language domain", () => {
  it("the POST body schema is closed, with locale required", () => {
    expect(postBody.additionalProperties).toBe(false);
    expect(postBody.required).toEqual(["locale"]);
    expect(Object.keys(postBody.properties ?? {})).toEqual(["locale"]);
  });

  it("the invalid-input vector reads as null", () => {
    const invalid = vectorsOf("profile.interface-locale.post").filter(
      (v) => v.name === "invalid-input",
    );
    expect(invalid.length).toBeGreaterThan(0);
    for (const v of invalid) expect(parseInterfaceLocaleSetting(v.request.body), v.name).toBeNull();
  });

  it("the POST and GET schemas name exactly the domain set; GET also allows null", () => {
    const posted = literals(postBody.properties?.["locale"] ?? {});
    expect([...posted.values].sort()).toEqual(SET);
    expect(posted.nullable).toBe(false);
    const read = literals(getBody.properties?.["locale"] ?? {});
    expect([...read.values].sort()).toEqual(SET);
    expect(read.nullable).toBe(true);
  });

  it("the set is the offered interface languages", () => {
    expect([...OFFERED_LANGUAGES].sort()).toEqual(SET);
    expect([DEFAULT_LANGUAGE, ...Object.keys(INTERFACE_CATALOGUES)].sort()).toEqual(SET);
  });

  it("every saved POST body is accepted and answered with the same locale", () => {
    const saved = vectorsOf("profile.interface-locale.post").filter(
      (v) => v.response.status === 200,
    );
    expect(saved.length).toBeGreaterThan(0);
    for (const v of saved) {
      const sent = parseInterfaceLocaleSetting(v.request.body);
      expect(sent, v.name).not.toBeNull();
      expect(localeOf(v.response.body), v.name).toBe(sent?.locale);
    }
  });

  it("every GET answer is a member of the set or null", () => {
    const read = vectorsOf("profile.interface-locale.get").filter((v) => v.response.status === 200);
    expect(read.length).toBeGreaterThan(0);
    for (const v of read) {
      const locale = localeOf(v.response.body);
      if (locale !== null)
        expect(parseInterfaceLocaleSetting({ locale }), v.name).toEqual({ locale });
    }
  });
});

// DAN-806 (Ductus#1836 c.6906291102): the contract package imports nothing
// from server/domain, so the vector of settings.catalogue.get is held equal to
// the catalogue here, and the contract's key and level schemas take every
// catalogue entry. A cross-area test (docs/server-map.md §2), as
// contract-only.test.ts.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import type { VectorFile } from "../../server/contracts/index.ts";
import { SETTING_LEVELS, SETTINGS_CATALOGUE } from "../../server/domain/index.ts";

const route = (id: string) => {
  const found = ROUTES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no route ${id}`);
  return found;
};

describe("settings catalogue and contract", () => {
  it("the success vector of settings.catalogue.get is the catalogue", () => {
    const url = new URL(
      "../../server/contracts/vectors/settings.catalogue.get.json",
      import.meta.url,
    );
    const file = JSON.parse(readFileSync(url, "utf8")) as VectorFile;
    const success = file.vectors.filter((vector) => vector.kind === "success");
    expect(success.length).toBeGreaterThan(0);
    for (const vector of success)
      expect(vector.response.body).toEqual({
        keys: JSON.parse(JSON.stringify(SETTINGS_CATALOGUE)),
      });
  });

  it("the catalogue answer matches the contract schema", () => {
    const schema = route("settings.catalogue.get").responses[0]?.body;
    expect(schema).toBeDefined();
    expect(Value.Check(schema!, { keys: SETTINGS_CATALOGUE })).toBe(true);
  });

  it("every catalogue key and default fits the body of settings.values.put", () => {
    const body = route("settings.values.put").request.body;
    expect(body).toBeDefined();
    for (const definition of SETTINGS_CATALOGUE)
      for (const level of definition.levels)
        expect(
          Value.Check(body!, {
            level,
            course: null,
            key: definition.key,
            value: definition.default,
            locked: false,
            min: null,
            max: null,
          }),
          `${definition.key} at ${level}`,
        ).toBe(true);
  });

  it("the contract knows the same levels as the catalogue", () => {
    const body = route("settings.values.put").request.body;
    for (const level of SETTING_LEVELS)
      expect(
        Value.Check(body!, {
          level,
          course: null,
          key: "a.b",
          value: null,
          locked: false,
          min: null,
          max: null,
        }),
      ).toBe(true);
    expect(
      Value.Check(body!, {
        level: "global",
        course: null,
        key: "a.b",
        value: null,
        locked: false,
        min: null,
        max: null,
      }),
    ).toBe(false);
  });
});

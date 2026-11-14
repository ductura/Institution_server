import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { openapiDocument } from "../../scripts/generate-contracts.ts";
import { breakingChanges } from "./breaking.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const doc = openapiDocument() as Obj;
const paths = doc.paths as Record<string, Obj>;
const operations = Object.entries(paths).flatMap(([path, ops]) => Object.keys(ops).map((method) => ({ path, method })));
// Every top-level field of a JSON success body, for every route.
const fields = operations.flatMap(({ path, method }) => {
  const responses = (paths[path]?.[method] as Obj).responses as Record<string, Obj>;
  return Object.entries(responses)
    .filter(([status]) => Number(status) < 400)
    .flatMap(([status, r]) => {
      const schema = ((r.content as Obj | undefined)?.["application/json"] as Obj | undefined)?.schema;
      return isObj(schema) && isObj(schema.properties) ? Object.keys(schema.properties).map((name) => ({ path, method, status, name })) : [];
    });
});

function edited(edit: (d: Obj) => void): Obj {
  const d = structuredClone(doc);
  (d.info as Obj).version = "1.1.0";
  edit(d);
  return d;
}

describe("breaking changes on the real contract", () => {
  it("has routes and success fields to remove", () => {
    expect(operations.length).toBeGreaterThan(5);
    expect(fields.length).toBeGreaterThan(5);
  });

  it("removing any route is reported", () => {
    fc.assert(
      fc.property(fc.constantFrom(...operations), ({ path, method }) => {
        const after = edited((d) => delete (d.paths as Record<string, Obj>)[path]?.[method]);
        expect(breakingChanges(doc, after)).toContain(`${method.toUpperCase()} ${path}: route removed`);
      }),
    );
  });

  it("removing any field of a success body is reported", () => {
    fc.assert(
      fc.property(fc.constantFrom(...fields), ({ path, method, status, name }) => {
        const after = edited((d) => {
          const op = (d.paths as Record<string, Obj>)[path]?.[method] as Obj;
          const body = (((op.responses as Record<string, Obj>)[status]?.content as Obj)["application/json"] as Obj).schema as Obj;
          delete (body.properties as Obj)[name];
          body.required = [];
        });
        expect(breakingChanges(doc, after)).toContain(`${method.toUpperCase()} ${path} response ${status}.${name}: field removed`);
      }),
    );
  });
});

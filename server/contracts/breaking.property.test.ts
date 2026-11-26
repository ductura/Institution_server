import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { openapiDocument } from "../../scripts/index.ts";
import { breakingChanges } from "./breaking.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const doc = openapiDocument() as Obj;
const paths = doc.paths as Record<string, Obj>;
const operations = Object.entries(paths).flatMap(([path, ops]) =>
  Object.keys(ops).map((method) => ({ path, method })),
);
// Every top-level field of a JSON success body, for every route.
const fields = operations.flatMap(({ path, method }) => {
  const responses = (paths[path]?.[method] as Obj).responses as Record<string, Obj>;
  return Object.entries(responses)
    .filter(([status]) => Number(status) < 400)
    .flatMap(([status, r]) => {
      const schema = ((r.content as Obj | undefined)?.["application/json"] as Obj | undefined)
        ?.schema;
      return isObj(schema) && isObj(schema.properties)
        ? Object.keys(schema.properties).map((name) => ({ path, method, status, name }))
        : [];
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

  // One run edits and compares the whole published contract, so the time grows
  // with the number of routes; the default 5 s was exceeded on CI (runs
  // 44803706644, 44805251704). An explicit limit as the oneOf test below has;
  // no run is dropped and every route is still covered.
  it("removing any route is reported", () => {
    fc.assert(
      fc.property(fc.constantFrom(...operations), ({ path, method }) => {
        const after = edited((d) => delete (d.paths as Record<string, Obj>)[path]?.[method]);
        expect(breakingChanges(doc, after)).toContain(
          `${method.toUpperCase()} ${path}: route removed`,
        );
      }),
    );
  }, 30_000);

  it("removing any field of a success body is reported", () => {
    fc.assert(
      fc.property(fc.constantFrom(...fields), ({ path, method, status, name }) => {
        const after = edited((d) => {
          const op = (d.paths as Record<string, Obj>)[path]?.[method] as Obj;
          const body = (
            ((op.responses as Record<string, Obj>)[status]?.content as Obj)[
              "application/json"
            ] as Obj
          ).schema as Obj;
          delete (body.properties as Obj)[name];
          body.required = [];
        });
        expect(breakingChanges(doc, after)).toContain(
          `${method.toUpperCase()} ${path} responses/${status}/content/application~1json/schema/properties/${name}: field removed`,
        );
      }),
    );
  }, 30_000);
});

// DAN-791: every oneOf of the published document has a discriminator, so a new
// optional field in any of its branches is safe; one that is required is not.
describe("a new field in a oneOf branch of the real contract", () => {
  const branches: { pointer: string; at: (d: Obj) => Obj }[] = [];
  for (const { path, method } of operations) {
    const responses = (paths[path]?.[method] as Obj).responses as Record<string, Obj>;
    for (const [status, r] of Object.entries(responses)) {
      const schema = ((r.content as Obj | undefined)?.["application/json"] as Obj | undefined)
        ?.schema;
      if (!isObj(schema) || !Array.isArray(schema.oneOf)) continue;
      schema.oneOf.forEach((_, i) =>
        branches.push({
          pointer: `${method.toUpperCase()} ${path} responses/${status}/content/application~1json/schema/oneOf/${i}`,
          at: (d) => {
            const op = (d.paths as Record<string, Obj>)[path]?.[method] as Obj;
            const body = (
              ((op.responses as Record<string, Obj>)[status]?.content as Obj)[
                "application/json"
              ] as Obj
            ).schema as Obj;
            return (body.oneOf as Obj[])[i] as Obj;
          },
        }),
      );
    }
  }

  it("covers the 400 and 403 of the mutation guard", () => {
    const where = branches.map((b) => b.pointer).join("\n");
    expect(where).toContain("POST /api/v1/profile/interface-locale responses/403/");
    expect(where).toContain("POST /api/v1/profile/interface-locale responses/400/");
  });

  // Raised above the published version, so only the field itself can be reported.
  const [major = 0, minor = 0] = String((doc.info as Obj).version)
    .split(".")
    .map(Number);
  const raised = (edit: (d: Obj) => void): Obj =>
    edited((d) => {
      (d.info as Obj).version = `${major}.${minor + 1}.0`;
      edit(d);
    });

  // Each run edits and compares the whole published contract twice, so the
  // time grows with the contract: 3 s locally on main, 5.2 to 5.7 s on CI
  // runners (DAN-826-2b, ductura/server#196). An explicit limit, as
  // shutdown.property.test.ts has; no run is dropped. SRV-ED42-PRIJEDLOZI:
  // the contract has grown to about 30 s on CI runners, so the limit is 60 s.
  it("an optional one is safe, a required one is reported", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...branches),
        fc.stringMatching(/^[a-z][a-zA-Z]{0,11}$/u),
        ({ pointer, at }, name) => {
          const target = at(doc);
          fc.pre(!Object.hasOwn(target.properties as Obj, name));
          const optional = raised((d) => {
            (at(d).properties as Obj)[name] = { type: "string" };
          });
          expect(breakingChanges(doc, optional)).toEqual([]);
          const required = raised((d) => {
            (at(d).properties as Obj)[name] = { type: "string" };
            at(d).required = [...((at(d).required as string[]) ?? []), name];
          });
          expect(breakingChanges(doc, required)).toContain(
            `${pointer}/properties/${name}: field added`,
          );
        },
      ),
    );
  }, 60_000);
});

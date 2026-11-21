// Property (plan #1662 Z, ai-request-v1.md "Klase ulaza"): a request with
// any key outside the closed set, at any level, or with a Z4 field never
// reaches begin_request. The harness calls a counting stand-in for
// begin_request exactly when admission passes, as the route will.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { type AdmissionContext, admitAssistantRequest } from "./admission.ts";
import { ASSISTANT_REQUEST_KEYS, CLIENT_CONTROLLED_KEYS } from "./request.ts";

const KEY = "3f0c2a9e-6b1d-4c8e-9a7f-1e2d3c4b5a69";
const VALID = {
  assignmentId: "0b9d8c7e-1f2a-4b3c-8d4e-5f6a7b8c9d0e",
  conversationId: null,
  paragraph: "Izmišljeni odlomak o lokalnim izborima.",
  purposeCatalogVersion: 1,
  purposeKey: "proofreading",
};
const CONTEXT: AdmissionContext = {
  policy: {
    course: { aiPolicy: "encouraged" },
    assignmentVersion: {
      aiPolicy: "encouraged",
      aiPurposes: ["proofreading"],
      purposeCatalogVersion: 1,
    },
    institution: { transcriptionAndToolsEnabled: false },
  },
  costConfigured: true,
};

function run(body: unknown): { calls: number; outcome: string | null } {
  let calls = 0;
  const beginRequest = (): void => {
    calls += 1;
  };
  const result = admitAssistantRequest(
    { body: new TextEncoder().encode(JSON.stringify(body)), idempotencyKey: KEY },
    CONTEXT,
  );
  if (result.ok) beginRequest();
  return { calls, outcome: result.ok ? null : result.outcome };
}

const allowed = new Set<string>(ASSISTANT_REQUEST_KEYS);
const extraKey = fc.string({ minLength: 1, maxLength: 24 }).filter((key) => !allowed.has(key));
const anyValue = fc.jsonValue({ maxDepth: 2 });

describe("closed key set, property", () => {
  it("the valid base request does reach begin_request", () => {
    expect(run(VALID)).toEqual({ calls: 1, outcome: null });
  });

  it("an extra top-level key never reaches begin_request", () => {
    fc.assert(
      fc.property(extraKey, anyValue, (key, value) => {
        const body: Record<string, unknown> = { ...VALID };
        Object.defineProperty(body, key, {
          value,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        expect(run(body)).toEqual({ calls: 0, outcome: "invalid_request" });
      }),
    );
  });

  it("a Z4 field, with any value, never reaches begin_request", () => {
    fc.assert(
      fc.property(fc.constantFrom(...CLIENT_CONTROLLED_KEYS), anyValue, (key, value) => {
        expect(run({ ...VALID, [key]: value })).toEqual({ calls: 0, outcome: "invalid_request" });
      }),
    );
  });

  it("an object or array in place of any value never reaches begin_request", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ASSISTANT_REQUEST_KEYS),
        fc.oneof(
          fc.dictionary(fc.string({ maxLength: 12 }), anyValue),
          fc.array(anyValue, { maxLength: 4 }),
        ),
        (key, nested) => {
          expect(run({ ...VALID, [key]: nested })).toEqual({
            calls: 0,
            outcome: "invalid_request",
          });
        },
      ),
    );
  });

  it("dropping any key never reaches begin_request", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ASSISTANT_REQUEST_KEYS), (key) => {
        const body: Record<string, unknown> = { ...VALID };
        delete body[key];
        expect(run(body)).toEqual({ calls: 0, outcome: "invalid_request" });
      }),
    );
  });
});

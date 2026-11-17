// S-1H.3 (DAN-1003): the functional test passes over someone else's work only
// on the contract's 404 {"status":"not_found"}; every other answer fails it.
import { describe, expect, it } from "vitest";

import { notFoundProblem } from "./index.ts";

const ROUTE = "/api/v1/evidence/commit";

describe("notFoundProblem", () => {
  it.each([
    // The exact body under any other status: the status is checked, not only the body.
    ["200 with the not_found body", 200, { status: "not_found" }],
    ["403 with the not_found body", 403, { status: "not_found" }],
    ["500 with the not_found body", 500, { status: "not_found" }],
    ["200 with the other student's work", 200, { status: "opened", documentId: "d" }],
    ["401", 401, { status: "unauthenticated" }],
    ["403", 403, { status: "forbidden" }],
    ["409 not_accepting", 409, { status: "not_accepting" }],
    ["409 stale_base", 409, { status: "stale_base" }],
    ["422 invalid", 422, { status: "invalid" }],
    ["503 unavailable", 503, { status: "unavailable", stage: "context" }],
    ["404 with an extra key", 404, { status: "not_found", documentId: "d" }],
    ["404 with an own __proto__ key", 404, JSON.parse('{"__proto__":{},"status":"not_found"}')],
    ["404 with another code", 404, { status: "Not_Found" }],
    ["404 with a padded code", 404, { status: "not_found " }],
    ["404 with an NBSP in the code", 404, { status: "not_found " }],
    ["404 with an empty body", 404, {}],
    ["404 with an array body", 404, ["not_found"]],
    ["404 with a null body", 404, null],
    ["404 with a string body", 404, "not_found"],
  ])("fails on %s", (_name, status, body) => {
    const problem = notFoundProblem(ROUTE, { status, body: body as never });
    expect(problem).toContain(ROUTE);
    expect(problem).toContain(String(status));
    // The line names the route and status only: never a value of the body.
    expect(problem).not.toContain("documentId");
  });

  it("passes only on exactly 404 {status: not_found}", () => {
    expect(notFoundProblem(ROUTE, { status: 404, body: { status: "not_found" } })).toBeNull();
  });
});

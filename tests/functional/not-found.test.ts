// S-1H.3 (DAN-1003): the functional test passes over someone else's work only
// on the contract's 404 {"status":"not_found"}, compared as the very bytes of
// the answer; every other answer fails it.
import { describe, expect, it } from "vitest";

import { notFoundProblem } from "./index.ts";

const ROUTE = "/api/v1/evidence/commit";
const json = (value: unknown) => JSON.stringify(value);

describe("notFoundProblem", () => {
  it.each([
    // The exact body under any other status: the status is checked, not only the body.
    ["200 with the not_found body", 200, json({ status: "not_found" })],
    ["403 with the not_found body", 403, json({ status: "not_found" })],
    ["500 with the not_found body", 500, json({ status: "not_found" })],
    ["200 with the other student's work", 200, json({ status: "opened", documentId: "d" })],
    ["401", 401, json({ status: "unauthenticated" })],
    ["403", 403, json({ status: "forbidden" })],
    ["409 not_accepting", 409, json({ status: "not_accepting" })],
    ["409 stale_base", 409, json({ status: "stale_base" })],
    ["422 invalid", 422, json({ status: "invalid" })],
    ["503 unavailable", 503, json({ status: "unavailable", stage: "context" })],
    ["404 with an extra key", 404, json({ status: "not_found", documentId: "d" })],
    ["404 with an own __proto__ key", 404, '{"__proto__":{},"status":"not_found"}'],
    // JSON.parse keeps the last of repeated keys; the bytes do not pass.
    ["404 with a repeated key, not_found last", 404, '{"status":"opened","status":"not_found"}'],
    ["404 with another code", 404, json({ status: "Not_Found" })],
    ["404 with a padded code", 404, json({ status: "not_found " })],
    ["404 with an NBSP in the code", 404, json({ status: "not_found " })],
    ["404 with a DEL in the code", 404, json({ status: "not_found\u007f" })],
    ["404 with whitespace around the keys", 404, '{ "status": "not_found" }'],
    ["404 with a trailing CRLF", 404, '{"status":"not_found"}\r\n'],
    ["404 with a tab", 404, '{"status":\t"not_found"}'],
    ["404 with an escaped code", 404, '{"status":"not\\u005ffound"}'],
    ["404 with an empty body", 404, ""],
    ["404 with an empty object", 404, "{}"],
    ["404 with an HTML body", 404, "<html>not_found</html>"],
    ["404 with an array body", 404, json(["not_found"])],
    ["404 with a null body", 404, "null"],
    ["404 with a string body", 404, json("not_found")],
  ])("fails on %s", (_name, status, text) => {
    const problem = notFoundProblem(ROUTE, { status, text });
    expect(problem).toContain(ROUTE);
    expect(problem).toContain(String(status));
    // The line names the route and status only: never a value of the body.
    expect(problem).not.toContain("documentId");
    expect(problem).not.toContain("opened");
  });

  it('passes only on exactly 404 with the bytes {"status":"not_found"}', () => {
    expect(notFoundProblem(ROUTE, { status: 404, text: '{"status":"not_found"}' })).toBeNull();
  });
});

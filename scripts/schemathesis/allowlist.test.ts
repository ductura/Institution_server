// ISTR-7: the route allowlist of the Schemathesis probe stays read-only and inside the spec.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { allowlistProblems, STUDENT_READS } from "./allowlist.ts";

const spec = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "..", "openapi", "v1.json"), "utf8"),
);

describe("STUDENT_READS", () => {
  it("is a list of GET routes of openapi/v1.json without path parameters", () => {
    expect(allowlistProblems(spec, STUDENT_READS)).toEqual([]);
  });

  it("leaves out the routes that may write or hand out keys", () => {
    for (const path of ["/api/v1/notifications", "/api/v1/me/self-note-key"])
      expect(STUDENT_READS).not.toContain(path);
    expect(STUDENT_READS.filter((path) => /\/(auth|downloads?|exports?)\b/u.test(path))).toEqual(
      [],
    );
  });
});

describe("allowlistProblems", () => {
  const fake = {
    paths: { "/api/v1/a": { get: {} }, "/api/v1/b": { post: {} }, "/api/v1/c/{id}": { get: {} } },
  };

  it("names every route it cannot probe", () => {
    expect(
      allowlistProblems(fake, [
        "/api/v1/a",
        "/api/v1/b",
        "/api/v1/c/{id}",
        "/api/v1/x",
        "/health",
        "/api/v1/a",
      ]),
    ).toEqual([
      "the allowlist repeats a route",
      "/api/v1/b: no GET in the spec",
      "/api/v1/c/{id}: has a path parameter",
      "/api/v1/x: not in the spec",
      "/health: not under /api/v1/",
      "/health: not in the spec",
    ]);
  });

  it("refuses an empty allowlist", () => {
    expect(allowlistProblems(fake, [])).toEqual(["the allowlist is empty"]);
  });
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FormatRegistry, Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES, closed, defineRoute, error } from "./index.ts";
import { checkVectors, type VectorFile } from "./vectors.ts";

const VECTORS_DIR = fileURLToPath(new URL("./vectors/", import.meta.url));
// The one string format the contracts use: an ISO timestamp as Date.toISOString writes it.
if (!FormatRegistry.Has("date-time")) {
  FormatRegistry.Set(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
  );
}
const check = (schema: Parameters<typeof Value.Check>[0], value: unknown) =>
  Value.Check(schema, value);

function load(): Record<string, unknown> {
  const files: Record<string, unknown> = {};
  for (const name of readdirSync(VECTORS_DIR).filter((f) => f.endsWith(".json"))) {
    files[name.slice(0, -".json".length)] = JSON.parse(
      readFileSync(join(VECTORS_DIR, name), "utf8"),
    );
  }
  return files;
}

describe("contract vectors", () => {
  it("the folder holds only vector files and the README", () => {
    const other = readdirSync(VECTORS_DIR).filter((f) => !f.endsWith(".json"));
    expect(other).toEqual(["README.md"]);
  });

  it("every route has a success and every error, all matching its schemas", () => {
    expect(checkVectors(ROUTES, load(), check)).toEqual([]);
  });
});

describe("checkVectors refuses", () => {
  const route = defineRoute({
    id: "made-up.thing.post",
    method: "POST",
    path: "/api/v1/made-up/thing",
    inventory: "app/api/made-up/thing/route.ts",
    access: "signed_in",
    summary: "made up",
    request: {
      contentType: "application/json",
      maxBodyBytes: 64,
      body: closed({ name: Type.String({ minLength: 1 }) }),
    },
    responses: [{ status: 201, description: "made", body: closed({ id: Type.String() }) }],
    errors: [error(422, "invalid_input"), error(503, "unavailable", "none")],
  });
  const success = {
    name: "made",
    kind: "success",
    request: { body: { name: "Izmišljeno" } },
    response: { status: 201, contentType: "application/json", body: { id: "id-0001" } },
  } as const;
  const invalid = {
    name: "invalid-input",
    kind: "error",
    code: "invalid_input",
    request: { body: { name: "" } },
    response: { status: 422, contentType: "application/json", body: { error: "invalid_input" } },
  } as const;
  const unavailable = {
    name: "unavailable",
    kind: "error",
    code: "unavailable",
    request: { body: { name: "Izmišljeno" } },
    response: { status: 503 },
  } as const;
  const file = (...vectors: VectorFile["vectors"]): VectorFile => ({
    route: route.id,
    vectors,
  });
  const run = (f: unknown, extra: Record<string, unknown> = {}) =>
    checkVectors([route], { [route.id]: f, ...extra }, check);

  it("nothing for a complete file", () => {
    expect(run(file(success, invalid, unavailable))).toEqual([]);
  });

  it("a route without a vector for one of its errors", () => {
    expect(run(file(success, invalid))).toEqual([
      "made-up.thing.post: no error vector for 503 unavailable",
    ]);
  });

  it("a route without a success vector or without a file", () => {
    expect(run(file(invalid, unavailable))).toEqual([
      "made-up.thing.post: no success vector for 201",
    ]);
    expect(checkVectors([route], {}, check)).toEqual(["made-up.thing.post: no vectors file"]);
  });

  it("a file for no route and a file for another route", () => {
    expect(run(file(success, invalid, unavailable), { "made-up.other.get": {} })).toEqual([
      "made-up.other.get.json: no route with this id",
    ]);
    expect(run({ ...file(success, invalid, unavailable), route: "x.y.get" })).toEqual([
      "made-up.thing.post: file names route x.y.get",
    ]);
  });

  it("a file outside the vector format, an unknown key included", () => {
    expect(run({ route: route.id, vectors: [] })).toEqual([
      "made-up.thing.post: vectors file does not match the vector format",
    ]);
    expect(run(file({ ...success, note: "x" } as never, invalid, unavailable))).toEqual([
      "made-up.thing.post: vectors file does not match the vector format",
    ]);
  });

  it("an answer that does not match the contract", () => {
    const badSuccess = { ...success, response: { ...success.response, body: { id: 1 } } };
    const badError = { ...invalid, response: { ...invalid.response, body: { error: "other" } } };
    const withBody = { ...unavailable, response: { status: 503, contentType: "application/json" } };
    expect(run(file(badSuccess as never, badError as never, withBody as never))).toEqual([
      "made-up.thing.post: made: response body does not match the contract",
      "made-up.thing.post: invalid-input: response body does not match the contract",
      "made-up.thing.post: unavailable: the contract answers without a body",
    ]);
  });

  it("an unknown code or status, a wrong status and a duplicate name", () => {
    const unknown = { ...invalid, name: "nope", code: "nope" };
    const wrongStatus = {
      ...invalid,
      name: "wrong",
      response: { ...invalid.response, status: 400 },
    };
    const otherSuccess = { ...success, name: "other", response: { status: 200 } };
    expect(
      run(file(success, success, invalid, unavailable, unknown, wrongStatus, otherSuccess)),
    ).toEqual([
      "made-up.thing.post: duplicate vector made",
      "made-up.thing.post: nope: code nope is not a contract error",
      "made-up.thing.post: wrong: status 400, contract says 422",
      "made-up.thing.post: other: status 200 is not a contract success",
    ]);
  });

  it("a success reached by a request the contract refuses", () => {
    const badBody = { ...success, request: { body: { name: "" } } };
    const raw = { ...success, request: { rawBody: "{}" } };
    const both = { ...success, name: "both", request: { body: { name: "a" }, rawBody: "{}" } };
    expect(run(file(badBody, invalid, unavailable))).toEqual([
      "made-up.thing.post: made: request body does not match the contract",
    ]);
    expect(run(file(raw, both, invalid, unavailable))).toEqual([
      "made-up.thing.post: made: request body does not match the contract",
      "made-up.thing.post: both: request has both body and rawBody",
      "made-up.thing.post: both: request body does not match the contract",
    ]);
  });

  it("a success without a declared header, or with an empty one", () => {
    const redirect = defineRoute({
      ...route,
      id: "made-up.thing.get",
      method: "GET",
      request: {},
      responses: [{ status: 303, description: "redirect", headers: ["location", "set-cookie"] }],
      errors: [],
    });
    const answer = (headers: Record<string, string | readonly string[]>) => ({
      route: redirect.id,
      vectors: [
        { name: "redirect", kind: "success", request: {}, response: { status: 303, headers } },
      ],
    });
    const runRedirect = (headers: Record<string, string | readonly string[]>) =>
      checkVectors([redirect], { [redirect.id]: answer(headers) }, check);
    expect(runRedirect({ location: "/", "set-cookie": ["a=b"] })).toEqual([]);
    expect(runRedirect({ location: "/" })).toEqual([
      "made-up.thing.get: redirect: missing header set-cookie",
    ]);
    expect(runRedirect({ location: "", "set-cookie": [] })).toEqual([
      "made-up.thing.get: redirect: missing header location",
      "made-up.thing.get: redirect: missing header set-cookie",
    ]);
    expect(runRedirect({ location: "/", "set-cookie": [""] })).toEqual([
      "made-up.thing.get: redirect: missing header set-cookie",
    ]);
  });
});

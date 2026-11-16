// S-1L.3 (DAN-789 a): the one table from an error code to its message key,
// a text for every key in hr and en, and the v1 key (errors.<code>) only in
// the x-errors and x-fallback the guard keeps as they were in v1.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import type { TObject } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import { messagesEn, messagesHr, textOf, type MessageKey } from "../../locales/index.ts";
import { openapiDocument, toPosix, v1Key } from "../../scripts/index.ts";
import {
  ERROR_MESSAGE_KEYS,
  error,
  FALLBACK,
  INTERNAL,
  METHOD_NOT_ALLOWED,
  ROUTES,
  SERVER_ERRORS,
  SHARED_ERRORS,
  v1Error,
} from "./index.ts";

const camel = (code: string) =>
  code.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());

describe("ERROR_MESSAGE_KEYS", () => {
  it("maps each snake_case code to errors.<camelCase>, one key per code", () => {
    for (const [code, key] of ERROR_MESSAGE_KEYS) {
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect(key).toBe(`errors.${camel(code)}`);
    }
    expect(new Set(ERROR_MESSAGE_KEYS.values()).size).toBe(ERROR_MESSAGE_KEYS.size);
  });

  it("has a row for every code of SERVER_ERRORS and no row no error uses", () => {
    expect(SERVER_ERRORS).toEqual(
      expect.arrayContaining([...SHARED_ERRORS, FALLBACK.error, METHOD_NOT_ALLOWED.error]),
    );
    for (const route of ROUTES)
      expect(SERVER_ERRORS).toEqual(expect.arrayContaining([...route.errors]));
    for (const spec of SERVER_ERRORS) expect(spec.key).toBe(ERROR_MESSAGE_KEYS.get(spec.code));
    const used = new Set(SERVER_ERRORS.map((spec) => spec.code));
    expect([...ERROR_MESSAGE_KEYS.keys()].filter((code) => !used.has(code))).toEqual([]);
  });

  it("a code without a row cannot be declared", () => {
    expect(() => error(404, "made_up_code")).toThrow(/no message key/u);
    expect(() => v1Error(400, "__proto__")).toThrow(/no message key/u);
    expect(() => error(404, "toString")).toThrow(/no message key/u);
  });
});

describe("every message key", () => {
  it.each([...new Set(SERVER_ERRORS.map((spec) => spec.key))])(
    "%s has a text in hr and en",
    (key) => {
      expect(textOf(messagesHr, key as MessageKey)).toEqual(expect.stringMatching(/\S/u));
      expect(textOf(messagesEn, key as MessageKey)).toEqual(expect.stringMatching(/\S/u));
    },
  );

  it("errors in hr and en has no text that no error uses", () => {
    const used = new Set(SERVER_ERRORS.map((spec) => spec.key));
    for (const table of [messagesHr, messagesEn])
      expect(Object.keys(table.errors).filter((name) => !used.has(`errors.${name}`))).toEqual([]);
  });

  it("the v1 spelling of a key has no text", () => {
    expect(() => textOf(messagesHr, "errors.not_found" as MessageKey)).toThrow();
    expect(() => textOf(messagesHr, "errors.madeUpCode" as MessageKey)).toThrow();
  });
});

describe("the OpenAPI document", () => {
  const document = openapiDocument() as {
    "x-fallback": { key: string; code: string };
    paths: Record<string, Record<string, { "x-errors": { code: string; key: string }[] }>>;
  };

  it("publishes the v1 key errors.<code> in x-errors and x-fallback only, as v1 did", () => {
    expect(document["x-fallback"].key).toBe(v1Key(FALLBACK.error.code));
    for (const operations of Object.values(document.paths))
      for (const operation of Object.values(operations))
        for (const entry of operation["x-errors"]) expect(entry.key).toBe(v1Key(entry.code));
    // Anywhere else a v1 key of a code with "_" never appears.
    const rest = JSON.stringify({ ...document, "x-fallback": null, paths: stripXErrors(document) });
    for (const [code] of ERROR_MESSAGE_KEYS)
      if (code.includes("_")) expect(rest).not.toContain(`"${v1Key(code)}"`);
  });

  it("publishes the camelCase messageKey in the problem body schema", () => {
    const schema = INTERNAL.error.body as TObject;
    expect(schema.properties["messageKey"]).toMatchObject({ const: "errors.internal" });
    const notFound = FALLBACK.error.body as TObject;
    expect(notFound.properties["messageKey"]).toMatchObject({ const: "errors.notFound" });
  });
});

function stripXErrors(document: { paths: Record<string, Record<string, object>> }): unknown {
  return Object.fromEntries(
    Object.entries(document.paths).map(([path, operations]) => [
      path,
      Object.fromEntries(
        Object.entries(operations).map(([method, operation]) => {
          const rest = { ...(operation as Record<string, unknown>) };
          delete rest["x-errors"];
          return [method, rest];
        }),
      ),
    ]),
  );
}

// v1Key is the one place that spells errors.<code>: no other source builds it.
describe("server and script sources", () => {
  // fileURLToPath: a URL's pathname keeps %20 and gives /D:/ on Windows.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory())
        return entry.name === "generated" || entry.name === "node_modules" ? [] : sources(path);
      return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
    });

  it("build errors.<code> only in v1Key of the generator", () => {
    const files = [...sources(join(root, "server")), ...sources(join(root, "scripts"))];
    const building = files
      .filter((file) => /errors\.\$\{/u.test(readFileSync(file, "utf8")))
      .map((file) => toPosix(relative(root, file)));
    expect(building).toEqual(["scripts/generate-contracts.ts"]);
  });
});

// Option (c) of DAN-789: a field added under a oneOf breaks v1 (breaking.ts),
// so no status with several JSON errors carries the problem fields, and a pair
// of status and code is answered in one shape only.
describe("the problem body under a oneOf", () => {
  it("is never there: those errors keep their v1 body", () => {
    for (const route of ROUTES) {
      const json = route.errors.filter((spec) => typeof spec.body === "object");
      for (const spec of json) {
        if (json.filter((other) => other.status === spec.status).length < 2) continue;
        const where = `${route.id} ${spec.status} ${spec.code}`;
        expect(Object.keys((spec.body as TObject).properties), where).not.toContain("messageKey");
      }
    }
  });

  it("an error marked v1 has exactly {error: code}, and its pair is never a problem body", () => {
    const v1 = SERVER_ERRORS.filter((spec) => spec.v1 === true);
    // The pairs, once each: several routes may declare the same guard error.
    expect([...new Set(v1.map((spec) => `${spec.status} ${spec.code}`))].sort()).toEqual([
      "400 body_stream_error",
      "400 content_length_invalid",
      "400 content_length_mismatch",
      "400 invalid_json",
      "403 cross_site",
      "403 origin_mismatch",
      "403 origin_missing",
    ]);
    for (const spec of v1)
      expect((spec.body as TObject).properties).toEqual({
        error: expect.objectContaining({ const: spec.code }),
      });
    const pairs = new Set(v1.map((spec) => `${spec.status} ${spec.code}`));
    const problem = SERVER_ERRORS.filter(
      (spec) => typeof spec.body === "object" && "messageKey" in (spec.body as TObject).properties,
    );
    expect(problem.filter((spec) => pairs.has(`${spec.status} ${spec.code}`))).toEqual([]);
  });
});

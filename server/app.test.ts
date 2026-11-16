// DAN-782: the transitional server answers errors as {code, messageKey}; every
// key has its Croatian text in locales/hr.json under `app`, and `app` holds
// exactly those keys.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { APP_ERRORS } from "./app.ts";

const catalogue: unknown = JSON.parse(
  readFileSync(new URL("../locales/hr.json", import.meta.url), "utf8"),
);

/** The non-empty text under a dotted key, or null when there is none. */
function textAt(root: unknown, key: string): string | null {
  const leaf = key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" && Object.hasOwn(node, part)
          ? (node as Record<string, unknown>)[part]
          : undefined,
      root,
    );
  return typeof leaf === "string" && leaf.trim().length > 0 ? leaf : null;
}

const errors = Object.values(APP_ERRORS);

describe("transitional server errors (DAN-782)", () => {
  it("has a Croatian text in locales/hr.json for every messageKey", () => {
    for (const { body } of errors)
      expect(textAt(catalogue, body.messageKey), body.messageKey).not.toBeNull();
  });

  it("keeps the `app` section to exactly the keys the server answers", () => {
    const section = (catalogue as { app?: Record<string, unknown> }).app ?? {};
    expect(
      Object.keys(section)
        .map((k) => `app.${k}`)
        .sort(),
    ).toEqual(errors.map(({ body }) => body.messageKey).sort());
  });

  it("gives every error a distinct APP_ code and key and an error status", () => {
    expect(errors).toHaveLength(8);
    for (const { status, body } of errors) {
      expect(body.code).toMatch(/^APP_[A-Z]+(?:_[A-Z]+)*$/u);
      expect(body.messageKey).toMatch(/^app\.[a-z]+(?:_[a-z]+)*$/u);
      expect(status).toBeGreaterThanOrEqual(400);
      expect(status).toBeLessThan(500);
    }
    expect(new Set(errors.map(({ body }) => body.code)).size).toBe(errors.length);
    expect(new Set(errors.map(({ body }) => body.messageKey)).size).toBe(errors.length);
  });

  it("carries no text in the body: two ASCII fields, code and key", () => {
    for (const { body } of errors) {
      expect(Object.keys(body).sort()).toEqual(["code", "messageKey"]);
      expect(JSON.stringify(body)).toMatch(/^[\x20-\x7e]*$/u);
    }
  });

  // Negative: the lookup the checks above rely on finds no text where there is none.
  it.each([
    ["app.ne_postoji", catalogue],
    ["app", catalogue],
    ["app.login_required", JSON.parse('{"app":{"login_required":"  "}}') as unknown],
    ["app.login_required", JSON.parse('{"app":{"login_required":1}}') as unknown],
    ["app.login_required", { app: {} }],
    ["app.toString", catalogue],
    ["app.__proto__", catalogue],
  ])("finds no text for %s", (key, root) => {
    expect(textAt(root, key)).toBeNull();
  });
});

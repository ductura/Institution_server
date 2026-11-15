import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  DEVELOPMENT_KEY_RESULT_FAULTS,
  developmentKeyError,
  KMS_TRANSPORT_ERROR_KINDS,
  kmsTransportError,
  SIGNING_ERRORS,
} from "./signing-errors.ts";

const catalogue: unknown = JSON.parse(
  readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8"),
);
const lookup = (key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      catalogue,
    );

describe("signing port errors (docs/CODE_STYLE.md §8)", () => {
  it("has a Croatian text in locales/hr.json for every messageKey", () => {
    for (const error of SIGNING_ERRORS) {
      const text = lookup(error.messageKey);
      expect(typeof text === "string" && text.trim().length > 0, error.messageKey).toBe(true);
    }
  });

  it("lists every error once, with a stable UPPER_SNAKE code and a distinct key", () => {
    expect(SIGNING_ERRORS).toHaveLength(
      KMS_TRANSPORT_ERROR_KINDS.length + 2 + DEVELOPMENT_KEY_RESULT_FAULTS.length,
    );
    for (const { code } of SIGNING_ERRORS) expect(code).toMatch(/^SIGNING_[A-Z]+(?:_[A-Z]+)*$/);
    expect(new Set(SIGNING_ERRORS.map((e) => e.code)).size).toBe(SIGNING_ERRORS.length);
    expect(new Set(SIGNING_ERRORS.map((e) => e.messageKey)).size).toBe(SIGNING_ERRORS.length);
  });

  it("maps every transport kind and every returned seed fault, each to its own code", () => {
    expect([...KMS_TRANSPORT_ERROR_KINDS].sort()).toEqual([
      "access_denied",
      "invalid_response",
      "key_not_found",
      "network",
      "service_error",
      "timeout",
    ]);
    expect(new Set(KMS_TRANSPORT_ERROR_KINDS.map((k) => kmsTransportError(k).code)).size).toBe(6);
    for (const fault of DEVELOPMENT_KEY_RESULT_FAULTS) {
      expect(developmentKeyError(fault).code).toBe(fault.toUpperCase());
    }
    expect(DEVELOPMENT_KEY_RESULT_FAULTS).not.toContain("signing_key_production");
    expect(DEVELOPMENT_KEY_RESULT_FAULTS).toHaveLength(8);
  });
});

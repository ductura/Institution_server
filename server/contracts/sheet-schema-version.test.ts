// SRV-V14-KIND: the optional sheetSchemaVersion of the evidence.open.post answer (the version of
// the sheet model of a "spreadsheet" work; Ductus#2058, WEB docs/nalazi/val14-razlika.md).
// The vectors cannot carry it until the open route fills it, so the schema is held here.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { ROUTES } from "./index.ts";

const route = ROUTES.find((r) => r.id === "evidence.open.post");
const body = route?.responses.find((r) => r.status === 200)?.body;
const opened = VECTORS.find((v) => v.route === "evidence.open.post" && v.name === "opened")
  ?.response.body as object;

describe("evidence.open.post sheetSchemaVersion", () => {
  it("accepts the answer without it, as every client of an earlier minor reads it", () => {
    expect(body !== undefined && Value.Check(body, opened)).toBe(true);
  });
  it("accepts 1 and nothing else", () => {
    expect(body !== undefined && Value.Check(body, { ...opened, sheetSchemaVersion: 1 })).toBe(
      true,
    );
    for (const bad of [0, 2, "1", null]) {
      expect(body !== undefined && Value.Check(body, { ...opened, sheetSchemaVersion: bad })).toBe(
        false,
      );
    }
  });
});

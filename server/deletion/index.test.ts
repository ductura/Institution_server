import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { DeletionService } from "./index.ts";

describe("server/deletion public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["DELETION_ROUTES", "DELETION_SCHEMAS"]);
    expect(area.DELETION_ROUTES).toEqual([]);
    expect(area.DELETION_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof DeletionService>().toEqualTypeOf<string>();
    expectTypeOf<DeletionService[string]>().toEqualTypeOf<never>();
  });
});

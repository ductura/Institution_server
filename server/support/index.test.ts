// DAN-851-2b: server/support is an empty area of the map (docs/server-map.md).
import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { SupportService } from "./index.ts";

describe("server/support public interface", () => {
  it("exports no values", () => {
    expect(Object.keys(area)).toEqual([]);
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof SupportService>().toEqualTypeOf<string>();
    expectTypeOf<SupportService[string]>().toEqualTypeOf<never>();
  });
});

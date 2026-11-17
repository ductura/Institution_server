// DAN-851-1b: server/profile is an empty area of the map (docs/server-map.md).
import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { ProfileService } from "./index.ts";

describe("server/profile public interface", () => {
  it("exports no values", () => {
    expect(Object.keys(area)).toEqual([]);
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof ProfileService>().toEqualTypeOf<string>();
    expectTypeOf<ProfileService[string]>().toEqualTypeOf<never>();
  });
});

import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { TrafficService } from "./index.ts";

describe("server/traffic public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["TRAFFIC_ROUTES", "TRAFFIC_SCHEMAS"]);
    expect(area.TRAFFIC_ROUTES).toEqual([]);
    expect(area.TRAFFIC_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof TrafficService>().toEqualTypeOf<string>();
    expectTypeOf<TrafficService[string]>().toEqualTypeOf<never>();
  });
});

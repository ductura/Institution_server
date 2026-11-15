import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { MetricsService } from "./index.ts";

describe("server/metrics public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["METRICS_ROUTES", "METRICS_SCHEMAS"]);
    expect(area.METRICS_ROUTES).toEqual([]);
    expect(area.METRICS_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof MetricsService>().toEqualTypeOf<string>();
    expectTypeOf<MetricsService[string]>().toEqualTypeOf<never>();
  });
});

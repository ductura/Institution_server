import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { TrafficService } from "./index.ts";

describe("server/traffic public interface", () => {
  it("exports the empty routes and schemas and the client IP and rate limit steps", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DEFAULT_RATE_LIMITS",
      "NO_TRUSTED_PROXIES",
      "RATE_LIMIT_CLASSES",
      "TRAFFIC_ROUTES",
      "TRAFFIC_SCHEMAS",
      "checkRateLimits",
      "clientIpLayer",
      "clientIpOf",
      "createRateLimiter",
      "parseTrustedProxies",
    ]);
    expect(area.TRAFFIC_ROUTES).toEqual([]);
    expect(area.TRAFFIC_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof TrafficService>().toEqualTypeOf<string>();
    expectTypeOf<TrafficService[string]>().toEqualTypeOf<never>();
  });
});

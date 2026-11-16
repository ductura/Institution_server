import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { TrafficService } from "./index.ts";

describe("server/traffic public interface", () => {
  it("exports the empty routes and schemas and the client IP, IP rules and rate limit steps the traffic recorder and the traffic tally", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DEFAULT_RATE_LIMITS",
      "MAX_ALLOWED_NETWORKS",
      "MAX_ALLOWED_NETWORKS_LENGTH",
      "MAX_DURATION_MS",
      "NO_ALLOWED_NETWORKS",
      "NO_TRUSTED_PROXIES",
      "RATE_LIMIT_CLASSES",
      "STATUS_CLOSED_EARLY",
      "TRAFFIC_METHODS",
      "TRAFFIC_ROUTES",
      "TRAFFIC_SCHEMAS",
      "checkRateLimits",
      "clientIpLayer",
      "clientIpOf",
      "createRateLimiter",
      "createTrafficRecorder",
      "createTrafficTally",
      "isOpsPath",
      "networkAllows",
      "parseAllowedNetworks",
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

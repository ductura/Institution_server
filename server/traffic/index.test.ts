import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { TrafficService } from "./index.ts";

describe("server/traffic public interface", () => {
  it("exports the empty routes and schemas and the client IP, IP rules and rate limit steps the traffic recorder, the traffic tally and the traffic summary", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DEFAULT_RATE_LIMITS",
      "MAX_ALLOWED_NETWORKS",
      "MAX_ALLOWED_NETWORKS_LENGTH",
      "MAX_DURATION_MS",
      "MAX_ENTRIES",
      "MAX_WINDOW_MINUTES",
      "NO_ALLOWED_NETWORKS",
      "NO_TRUSTED_PROXIES",
      "RATE_LIMIT_CLASSES",
      "STATUS_CLOSED_EARLY",
      "TRAFFIC_METHODS",
      "TRAFFIC_ROUTES",
      "TRAFFIC_SCHEMAS",
      "TRAFFIC_SUMMARY_ERROR_CODES",
      "checkRateLimits",
      "clientIpLayer",
      "clientIpOf",
      "createRateLimiter",
      "createTrafficRecorder",
      "createTrafficSummary",
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

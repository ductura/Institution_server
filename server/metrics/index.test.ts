import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { MetricsService } from "./index.ts";

describe("server/metrics public interface", () => {
  it("exports the empty routes and schemas and the external call pattern (S-1E-c) the collector and the metric_sample writer (S-1K.4-b)", () => {
    expect(Object.keys(area).sort()).toEqual([
      "EXTERNAL_CALL_OUTCOMES",
      "EXTERNAL_SERVICES",
      "METRICS_ROUTES",
      "METRICS_SCHEMAS",
      "METRICS_SKIP_REASONS",
      "METRICS_WRITE_DEADLINE_MS",
      "METRIC_SAMPLE_INSERT",
      "createExternalCaller",
      "createMetricSampleWriter",
      "createMetricsCollector",
    ]);
    expect(area.METRICS_ROUTES).toEqual([]);
    expect(area.METRICS_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof MetricsService>().toEqualTypeOf<string>();
    expectTypeOf<MetricsService[string]>().toEqualTypeOf<never>();
  });
});

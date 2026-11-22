import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { SettingsService } from "./index.ts";

describe("server/settings public interface", () => {
  it("exports the empty routes and schemas, the metrics interval, the institutions check and the test mode check", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DEFAULT_METRICS_INTERVAL_MS",
      "INSTITUTIONS_ERROR_CODES",
      "METRICS_INTERVAL_MAX_MS",
      "METRICS_INTERVAL_MIN_MS",
      "SETTINGS_ROUTES",
      "SETTINGS_SCHEMAS",
      "institutionsProblems",
      "isNonProductionBuild",
      "kmsProblems",
      "kmsSettings",
      "loadInstitutions",
      "metricsIntervalMs",
      "metricsIntervalProblems",
      "testModeProblems",
    ]);
    expect(area.SETTINGS_ROUTES).toEqual([]);
    expect(area.SETTINGS_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof SettingsService>().toEqualTypeOf<string>();
    expectTypeOf<SettingsService[string]>().toEqualTypeOf<never>();
  });
});

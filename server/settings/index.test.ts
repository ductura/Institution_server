import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { SettingsService } from "./index.ts";

describe("server/settings public interface", () => {
  it("exports the empty routes and schemas, the metrics interval, the institutions check, the test mode check and the deployment check", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DEFAULT_METRICS_INTERVAL_MS",
      "DEPLOYMENT_VARIABLE",
      "INSTITUTIONS_ERROR_CODES",
      "METRICS_INTERVAL_MAX_MS",
      "METRICS_INTERVAL_MIN_MS",
      "PRODUCTION_DOMAIN",
      "SETTINGS_ROUTES",
      "SETTINGS_SCHEMAS",
      "deploymentProblems",
      "institutionsProblems",
      "isNonProductionBuild",
      "isProductionHost",
      "isStagingDeployment",
      "loadInstitutions",
      "metricsIntervalMs",
      "metricsIntervalProblems",
      "stagingDeploymentOrigin",
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

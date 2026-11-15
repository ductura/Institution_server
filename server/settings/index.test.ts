import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { SettingsService } from "./index.ts";

describe("server/settings public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["SETTINGS_ROUTES", "SETTINGS_SCHEMAS"]);
    expect(area.SETTINGS_ROUTES).toEqual([]);
    expect(area.SETTINGS_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof SettingsService>().toEqualTypeOf<string>();
    expectTypeOf<SettingsService[string]>().toEqualTypeOf<never>();
  });
});

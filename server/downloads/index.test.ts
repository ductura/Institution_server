import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { DownloadsService } from "./index.ts";

describe("server/downloads public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["DOWNLOADS_ROUTES", "DOWNLOADS_SCHEMAS"]);
    expect(area.DOWNLOADS_ROUTES).toEqual([]);
    expect(area.DOWNLOADS_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof DownloadsService>().toEqualTypeOf<string>();
    expectTypeOf<DownloadsService[string]>().toEqualTypeOf<never>();
  });
});

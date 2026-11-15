import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { TestServerService } from "./index.ts";

describe("server/test-server public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["TEST_SERVER_ROUTES", "TEST_SERVER_SCHEMAS"]);
    expect(area.TEST_SERVER_ROUTES).toEqual([]);
    expect(area.TEST_SERVER_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof TestServerService>().toEqualTypeOf<string>();
    expectTypeOf<TestServerService[string]>().toEqualTypeOf<never>();
  });
});

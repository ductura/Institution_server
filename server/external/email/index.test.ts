import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { EmailService } from "./index.ts";

describe("server/external/email public interface", () => {
  it("exports only the empty routes and schemas", () => {
    expect(Object.keys(area).sort()).toEqual(["EMAIL_ROUTES", "EMAIL_SCHEMAS"]);
    expect(area.EMAIL_ROUTES).toEqual([]);
    expect(area.EMAIL_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof EmailService>().toEqualTypeOf<string>();
    expectTypeOf<EmailService[string]>().toEqualTypeOf<never>();
  });
});

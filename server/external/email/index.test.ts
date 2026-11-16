import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { EmailService } from "./index.ts";

describe("server/external/email public interface", () => {
  it("exports the empty routes and schemas and the guarded sender (S-1E-c)", () => {
    expect(Object.keys(area).sort()).toEqual([
      "EMAIL_ERRORS",
      "EMAIL_ROUTES",
      "EMAIL_SCHEMAS",
      "EMAIL_TIMEOUT",
      "EMAIL_UNAVAILABLE",
      "guardEmail",
    ]);
    expect(area.EMAIL_ROUTES).toEqual([]);
    expect(area.EMAIL_SCHEMAS).toEqual({});
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof EmailService>().toEqualTypeOf<string>();
    expectTypeOf<EmailService[string]>().toEqualTypeOf<never>();
  });
});

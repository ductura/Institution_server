// DAN-852-1, 3a: the public interface of server/institution (docs/server-map.md).
import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { CourseBody, EnrollmentCodeBody, InstitutionService } from "./index.ts";

describe("server/institution public interface", () => {
  it("exports only the two body parsers", () => {
    expect(Object.keys(area).sort()).toEqual(["parseCourseBody", "parseEnrollmentCodeBody"]);
  });

  it("has a service type without members and a closed course body", () => {
    expectTypeOf<InstitutionService[string]>().toEqualTypeOf<never>();
    expectTypeOf<keyof CourseBody>().toEqualTypeOf<"name" | "academicYear" | "aiPolicy">();
    expectTypeOf<EnrollmentCodeBody>().toEqualTypeOf<{ validUntil: string }>();
  });
});

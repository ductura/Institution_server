// DAN-852-1, 3a, 3b: the public interface of server/institution (docs/server-map.md).
import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type {
  CourseBody,
  EnrollmentBody,
  EnrollmentCodeBody,
  InstitutionService,
} from "./index.ts";

describe("server/institution public interface", () => {
  it("exports only the three body parsers, the service factory and the student's courses (SRV-09)", () => {
    expect(Object.keys(area).sort()).toEqual([
      "WORK_TYPES",
      "createInstitutionService",
      "parseCourseBody",
      "parseEnrollmentBody",
      "parseEnrollmentCodeBody",
      "studentCoursesOf",
    ]);
  });

  it("has a service of three methods and closed bodies", () => {
    expectTypeOf<keyof InstitutionService>().toEqualTypeOf<
      "createCourse" | "issueEnrollmentCode" | "revokeEnrollmentCode"
    >();
    expectTypeOf<keyof CourseBody>().toEqualTypeOf<"name" | "academicYear" | "aiPolicy">();
    expectTypeOf<EnrollmentCodeBody>().toEqualTypeOf<{ validUntil: string }>();
    expectTypeOf<EnrollmentBody>().toEqualTypeOf<{ code: string }>();
  });
});

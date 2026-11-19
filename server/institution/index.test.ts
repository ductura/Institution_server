// DAN-852-1, 3a, 3b: the public interface of server/institution (docs/server-map.md).
import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type {
  AssignmentVersionBody,
  CourseBody,
  EnrollmentBody,
  EnrollmentCodeBody,
  InstitutionService,
} from "./index.ts";

describe("server/institution public interface", () => {
  it("exports only the four body parsers and the service factory", () => {
    expect(Object.keys(area).sort()).toEqual([
      "createInstitutionService",
      "parseAssignmentVersionBody",
      "parseCourseBody",
      "parseEnrollmentBody",
      "parseEnrollmentCodeBody",
    ]);
  });

  it("has a service of six methods and closed bodies", () => {
    expectTypeOf<keyof InstitutionService>().toEqualTypeOf<
      | "createCourse"
      | "issueEnrollmentCode"
      | "revokeEnrollmentCode"
      | "removeStudent"
      | "allowStudentReturn"
      | "publishAssignmentVersion"
    >();
    expectTypeOf<keyof AssignmentVersionBody>().toEqualTypeOf<"expectedVersion" | "content">();
    expectTypeOf<keyof CourseBody>().toEqualTypeOf<"name" | "academicYear" | "aiPolicy">();
    expectTypeOf<EnrollmentCodeBody>().toEqualTypeOf<{ validUntil: string }>();
    expectTypeOf<EnrollmentBody>().toEqualTypeOf<{ code: string }>();
  });
});

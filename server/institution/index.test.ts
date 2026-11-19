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
  it("exports only the seven body parsers, the notice template version and the service factory", () => {
    expect(Object.keys(area).sort()).toEqual([
      "NOTICE_TEMPLATE_VERSION",
      "createInstitutionService",
      "parseAcknowledgmentBody",
      "parseAssignmentVersionBody",
      "parseAssignmentWorkLanguageBody",
      "parseCourseBody",
      "parseEnrollmentBody",
      "parseEnrollmentCodeBody",
      "parseWorkLanguageExceptionBody",
    ]);
  });

  it("has a service of nine methods and closed bodies", () => {
    expectTypeOf<keyof InstitutionService>().toEqualTypeOf<
      | "createCourse"
      | "issueEnrollmentCode"
      | "revokeEnrollmentCode"
      | "removeStudent"
      | "allowStudentReturn"
      | "publishAssignmentVersion"
      | "setAssignmentWorkLanguage"
      | "setWorkLanguage"
      | "setWorkLanguageForDocument"
    >();
    expectTypeOf<keyof AssignmentVersionBody>().toEqualTypeOf<"expectedVersion" | "content">();
    expectTypeOf<keyof CourseBody>().toEqualTypeOf<"name" | "academicYear" | "aiPolicy">();
    expectTypeOf<EnrollmentCodeBody>().toEqualTypeOf<{ validUntil: string }>();
    expectTypeOf<EnrollmentBody>().toEqualTypeOf<{ code: string }>();
  });
});

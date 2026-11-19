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
  it("exports only the body parsers, the notice template version, the service factory, the access log read (SRV-11), the student's write bodies (SRV-10) and the student's courses (SRV-09)", () => {
    expect(Object.keys(area).sort()).toEqual([
      "MAX_ENROLLMENT_CODE_LENGTH",
      "NOTICE_TEMPLATE_VERSION",
      "WORK_TYPES",
      "accessLogCursorOf",
      "createInstitutionService",
      "parseAcknowledgmentBody",
      "parseAssignmentVersionBody",
      "parseAssignmentWorkLanguageBody",
      "parseCourseBody",
      "parseEnrollmentBody",
      "parseEnrollmentCodeBody",
      "parseNoticeReadBody",
      "parseStudentEnrollmentBody",
      "parseWorkLanguageExceptionBody",
      "readStudentAccessLog",
      "studentCoursesOf",
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

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
  it("exports the institution service, body parsers, and student and teacher reads", () => {
    expect(Object.keys(area).sort()).toEqual([
      "MAX_ENROLLMENT_CODE_LENGTH",
      "NOTICE_TEMPLATE_VERSION",
      "WORK_TYPES",
      "accessLogCursorOf",
      "createInstitutionService",
      "createStudentNotes",
      // SRV-14: the content of an assignment version (assignment-input.ts).
      "isAssignmentVersion",
      "parseAcknowledgmentBody",
      "parseAssignmentInput",
      "parseAssignmentVersionBody",
      "parseAssignmentWorkLanguageBody",
      "parseCourseBody",
      "parseEnrollmentBody",
      "parseEnrollmentCodeBody",
      "parseNoticeReadBody",
      "parseStudentEnrollmentBody",
      "parseWorkLanguageExceptionBody",
      "readAssignmentCurrentVersion",
      "readAssignmentOverview",
      "readStudentAccessLog",
      "readStudentRequirements",
      "readStudentSubmission",
      "readTeacherRoster",
      "studentCoursesOf",
    ]);
  });

  it("has a service of eight methods and closed bodies", () => {
    expectTypeOf<keyof InstitutionService>().toEqualTypeOf<
      | "createCourse"
      | "issueEnrollmentCode"
      | "revokeEnrollmentCode"
      | "removeStudent"
      | "allowStudentReturn"
      | "setAssignmentWorkLanguage"
      | "setWorkLanguage"
      | "setWorkLanguageForDocument"
    >();
    expectTypeOf<keyof CourseBody>().toEqualTypeOf<"name" | "academicYear" | "aiPolicy">();
    expectTypeOf<EnrollmentCodeBody>().toEqualTypeOf<{ validUntil: string }>();
    expectTypeOf<EnrollmentBody>().toEqualTypeOf<{ code: string }>();
  });
});

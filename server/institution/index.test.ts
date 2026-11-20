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
  it("exports only the body parsers, the service factory, the access log read (SRV-11), the student's write bodies (SRV-10), the student's courses (SRV-09), the assignment content (SRV-14) and the submission state and requirements reads (SRV-22)", () => {
    expect(Object.keys(area).sort()).toEqual([
      "MAX_ENROLLMENT_CODE_LENGTH",
      "WORK_TYPES",
      "accessLogCursorOf",
      "createInstitutionService",
      "createStudentNotes",
      // SRV-14: the content of an assignment version (assignment-input.ts).
      "isAssignmentVersion",
      "parseAssignmentInput",
      "parseAssignmentVersionBody",
      "parseAssignmentWorkLanguageBody",
      "parseCourseBody",
      "parseEnrollmentBody",
      "parseEnrollmentCodeBody",
      "parseNoticeReadBody",
      "parseStudentEnrollmentBody",
      "parseWorkLanguageExceptionBody",
      "readStudentAccessLog",
      "readStudentRequirements",
      "readStudentSubmission",
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

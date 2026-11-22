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
  it("exports only the notice template version, the body parsers, the service factory, the access log read (SRV-11), the student's write bodies (SRV-10), the student's courses (SRV-09), the assignment content (SRV-14) and the submission state and requirements reads (SRV-22) and the teacher's read of one student's state (SRV-30)", () => {
    expect(Object.keys(area).sort()).toEqual([
      "MAX_ENROLLMENT_CODE_LENGTH",
      "NOTICE_TEMPLATE_VERSION",
      "WORK_TYPES",
      "accessLogCursorOf",
      "createInstitutionService",
      "createStudentNotes",
      // SRV-2001: the faculty rules of an institution (faculty-rules.ts).
      "facultyRuleRefusal",
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
      "publishFacultyRule",
      // LOK-SRV-2: the administrator's reads (institution-courses.ts, teacher-roles.ts).
      "readAcademicYears",
      "readAssignmentCurrentVersion",
      "readAssignmentOverview",
      "readFacultyRules",
      "readInstitutionCourses",
      "readStudentAccessLog",
      "readStudentRequirements",
      "readStudentSubmission",
      "readTeacherRoles",
      "readTeacherRoster",
      "readTeacherSubmission",
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

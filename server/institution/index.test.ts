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
  it("exports only the body parsers, the service factory and the access log read (SRV-11, SRV-14)", () => {
    expect(Object.keys(area).sort()).toEqual([
      "accessLogCursorOf",
      "createInstitutionService",
      // SRV-14: the content of an assignment version (assignment-input.ts).
      "isAssignmentVersion",
      "parseAssignmentInput",
      "parseAssignmentVersionBody",
      "parseCourseBody",
      "parseEnrollmentBody",
      "parseEnrollmentCodeBody",
      "readStudentAccessLog",
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

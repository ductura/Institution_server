// Public interface of server/institution; other areas import only this file.
export {
  type AiPolicy,
  type CourseBody,
  type EnrollmentBody,
  type EnrollmentCodeBody,
  parseCourseBody,
  parseEnrollmentBody,
  parseEnrollmentCodeBody,
} from "./schemas.ts";
export {
  MAX_ENROLLMENT_CODE_LENGTH,
  type NoticeReadBody,
  parseNoticeReadBody,
  parseStudentEnrollmentBody,
  type StudentEnrollmentBody,
} from "./student-writes-route.ts";
export { createInstitutionService, type InstitutionService, type InvalidInput } from "./service.ts";

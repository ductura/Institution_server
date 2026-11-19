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
export { createInstitutionService, type InstitutionService, type InvalidInput } from "./service.ts";
export {
  type AssignmentInput,
  isAssignmentVersion,
  parseAssignmentInput,
  parseAssignmentVersionBody,
} from "./assignment-input.ts";

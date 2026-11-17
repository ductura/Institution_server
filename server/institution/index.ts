// Public interface of server/institution; other areas import only this file.
export {
  type AiPolicy,
  type CourseBody,
  type EnrollmentCodeBody,
  parseCourseBody,
  parseEnrollmentCodeBody,
} from "./schemas.ts";
export { createInstitutionService, type InstitutionService, type InvalidInput } from "./service.ts";

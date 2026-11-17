// Public interface of server/institution; other areas import only this file.
export {
  type AiPolicy,
  type CourseBody,
  type EnrollmentCodeBody,
  parseCourseBody,
  parseEnrollmentCodeBody,
} from "./schemas.ts";
export type { InstitutionService } from "./service.ts";

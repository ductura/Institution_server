// Public interface of server/institution; other areas import only this file.
export {
  isPlainName,
  parseRosterCsv,
  ROSTER_IMPORT_MAX_CSV_LENGTH,
  ROSTER_IMPORT_MAX_ROWS,
  type RosterFileError,
  type RosterParse,
  type RosterRow,
  type RosterRowProblem,
} from "./roster-import.ts";
export {
  facultyRuleRefusal,
  publishFacultyRule,
  readFacultyRules,
  type FacultyRuleInput,
} from "./faculty-rules.ts";
export {
  readAssistantSetting,
  type AssistantSettingSource,
  type FacultyAssistantSwitch,
} from "./assistant-setting.ts";
export { readAssignmentCurrentVersion } from "./assignment-current-version/index.ts";
export {
  type EnrollmentCodeStateRead,
  readEnrollmentCodeState,
} from "./enrollment-code-state/index.ts";
export {
  readAssignmentFollowUp,
  readAssignmentOverview,
  readTeacherRoster,
} from "./course-students.ts";
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
  type StudentAssignment,
  type StudentCourse,
  studentCoursesOf,
  WORK_TYPES,
} from "./student-assignments-route.ts";
export {
  MAX_ENROLLMENT_CODE_LENGTH,
  type NoticeReadBody,
  parseNoticeReadBody,
  parseStudentEnrollmentBody,
  type StudentEnrollmentBody,
} from "./student-writes-route.ts";
export {
  accessLogCursorOf,
  readStudentAccessLog,
  type StudentAccessLogAnswer,
  type StudentAccessLogEntry,
} from "./student-access-log-route.ts";
export {
  readStudentAssignmentSubmissions,
  type AssignmentSubmission,
  type StudentAssignmentSubmissionsAnswer,
} from "./student-assignment-submissions-route.ts";
export {
  readStudentSubmission,
  type StudentSubmissionAnswer,
  type StudentSubmissionState,
} from "./student-submission-route.ts";
export { readTeacherSubmission } from "./teacher-submission-route.ts";
export {
  readStudentRequirements,
  type StudentRequirementsAnswer,
  type StudentWordRange,
} from "./student-requirements-route.ts";
export {
  type AssignmentWorkLanguageBody,
  parseAssignmentWorkLanguageBody,
  parseWorkLanguageExceptionBody,
  type WorkLanguageExceptionBody,
} from "./work-language-bodies.ts";
export {
  type AcknowledgmentBody,
  NOTICE_TEMPLATE_VERSION,
  parseAcknowledgmentBody,
} from "./acknowledgment-body.ts";
export { createInstitutionService, type InstitutionService, type InvalidInput } from "./service.ts";
export { createStudentNotes } from "./student-notes-route.ts";
export {
  type AssignmentInput,
  isAssignmentVersion,
  parseAssignmentInput,
  parseAssignmentVersionBody,
} from "./assignment-input.ts";
// LOK-SRV-2: the administrator's reads of courses, academic years and teacher roles.
export { readAcademicYears, readInstitutionCourses } from "./institution-courses.ts";
export { readTeacherRoles } from "./teacher-roles.ts";
// SRV-MENTOR-3B: the retention job of the data of works that no longer exist.
export {
  purgeOrphanWorkDataJob,
  PURGE_ORPHAN_WORK_DATA_EVERY_MS,
  PURGE_ORPHAN_WORK_DATA_JOB,
  registerPurgeOrphanWorkData,
  type OrphanWorkDataPort,
  type PurgeOrphanWorkDataJob,
} from "./purge-orphan-work-data.ts";
// F4-PM2-R08-SRV: the accommodation mark of a work, read and set over HTTP.
export {
  readOwnWorkAccommodation,
  readWorkAccommodation,
  setWorkAccommodation,
  type WorkAccommodationRead,
  type WorkAccommodationWrite,
} from "./work-accommodation.ts";

import {
  attachmentRoutes,
  assistantRoutes,
  statementRoutes,
  authRoutes,
  clientRoutes,
  collaborationRoutes,
  consultationSlotRoutes,
  workInterviewRoutes,
  workInterviewPdfRoutes,
  mentorshipRoutes,
  mentorshipStudentRoutes,
  mentorshipConsultationRoutes,
  studentWorkRoutes,
  keyDatesGet,
  teachingTeamRoutes,
  workTeamRoutes,
  mentorNotesGet,
  mentorNotesPost,
  courseAggregateGet,
  institutionConfigRoutes,
  pilotMetricsGet,
  retentionGet,
  accessLogRoutes,
  downloadsRoutes,
  enrollmentRoutes,
  ERROR_CATALOG_DATA,
  evidenceRoutes,
  FALLBACK,
  institutionRoutes,
  liveRoutes,
  INTERNAL,
  METHOD_NOT_ALLOWED,
  opsRoutes,
  platformRoutes,
  profileRoutes,
  staffAffiliationRoutes,
  projectionRoutes,
  publicVerificationPost,
  publicVerificationRoutes,
  receiptPdfRoutes,
  workExportRoutes,
  SHARED_ERROR_HEADERS,
  SHARED_ERRORS,
  settingsRoutes,
  sourceLookupPost,
  studentRoutes,
  studentSourcesRoutes,
  sourceNotebookRoutes,
  sourceProofsRoutes,
  textCheckConfigRoutes,
  deadlineExtensionRoutes,
  legalHoldRoutes,
  studentDataExportRoutes,
  submissionsRoutes,
  assignmentCopyRoutes,
  merlinRosterRoutes,
  rosterImportRoutes,
  merlinPackageRoutes,
  supportRoutes,
  problemReportsPost,
  problemReportsGet,
  problemReportStatusPost,
  adminActionLogRoutes,
  teacherRoutes,
  teacherWorkingCriteriaRoutes,
  assignmentRubricRoutes,
  teacherSourcesRoutes,
  teacherWorkRoutes,
  originCompositionRoutes,
  assistantMatchRoutes,
  inputRhythmRoutes,
  declarationRequiredRoutes,
  declarationQuestionRoutes,
  lateSubmissionRoutes,
  originThresholdsRoutes,
  TOO_MANY_REQUESTS,
  versionsRoutes,
  workExportDocxRoutes,
  portableRecordRoutes,
  submissionPackageRoutes,
  teacherSubmissionsBulkRoutes,
  workVersionGet,
  workMessagesRoutes,
  mentorshipFollowRoutes,
  selfNoteSealedRoutes,
  notificationsRoutes,
  commentsRoutes,
  workCompareRoutes,
  directEditRoutes,
  importRoutes,
  workMilestonesRoutes,
  milestoneTemplateRoutes,
  workTemplateRoutes,
  assignmentTemplateRoutes,
  formatRulesRoutes,
  returnForRevisionRoutes,
  thesisRoutes,
  practiceJournalRoutes,
  consultationRecordsRoutes,
  eventDisputesRoutes,
  facultyRulesRoutes,
  assistantSettingRoutes,
  webauthnRoutes,
} from "./routes/index.ts";
import type { ErrorSpec, RouteContract } from "./schema/index.ts";

export { breakingChanges } from "./breaking.ts";
export { courseAggregateGet, CourseAggregateParams, type CourseAggregate } from "./routes/index.ts";
export {
  mentorshipFollowRoutes,
  ReadingPlaceInput,
  SeenInput,
  SEEN_MARKS_MAX,
  SelfNoteInput,
  SelfNoteState,
  WorkPlace,
} from "./routes/index.ts";
export {
  KDF_ITERATIONS,
  SEALED_LENGTHS,
  SealedSelfNoteInput,
  SealedSelfNoteState,
  SelfNoteKeyCheckedParams,
  SelfNoteKeyCheckedQuery,
  SelfNoteKeyInput,
  SelfNoteKeyState,
  selfNoteSealedRoutes,
} from "./routes/index.ts";
export { PILOT_METRICS_MIN_GROUP, PilotMetrics, pilotMetricsGet } from "./routes/index.ts";
export { RetentionClassReport, RetentionReport, retentionGet } from "./routes/index.ts";
export { AssistantSetting, assistantSettingGet } from "./routes/index.ts";
export { EXPORT_ALREADY_OPEN, EXPORT_ALREADY_OPEN_KEY } from "./routes/index.ts";
export { WORK_ACCESS_ROLES, WORK_ACCESS_SURFACES, workAccessGet } from "./routes/index.ts";
export { RESTORE_MAX_FROM_REVISION, RHYTHM_MAX_GAP_MS, RHYTHM_MAX_GAPS } from "./routes/index.ts";
export { WORK_INTERVIEW_NOTE_MAX_BYTES } from "./routes/index.ts";
export { MentorshipNotificationsPage } from "./routes/index.ts";
export {
  ROSTER_IMPORT_MAX_CSV_LENGTH,
  ROSTER_IMPORT_MAX_ROWS,
  ROSTER_IMPORT_REASONS,
  ROSTER_IMPORT_SOURCES,
} from "./routes/index.ts";
export { API_VERSION, MIN_CLIENT_VERSION } from "./version.ts";
export {
  WorkMilestoneApprovalInput,
  WorkMilestoneChangeInput,
  WorkMilestoneDueInput,
  WorkMilestoneId,
  WorkMilestoneRevisionInput,
  workMilestonesRoutes,
} from "./routes/index.ts";
export {
  MilestoneTemplateInput,
  WorkMilestoneAddInput,
  milestoneTemplateRoutes,
  WORK_TEMPLATE_TYPES,
  WorkTemplateInput,
  WorkTemplateType,
  workTemplateRoutes,
  AssignmentTemplateInput,
  assignmentTemplateRoutes,
  FormatRules,
  formatRulesRoutes,
  studentAssignmentFormatRulesGet,
  ReturnForRevisionInput,
  ReturnForRevisionResult,
  returnForRevisionRoutes,
} from "./routes/index.ts";
export {
  MentorConsentInput,
  THESIS_FORM_STATES,
  THESIS_STAGES,
  THESIS_WORK_TYPES,
  ThesisFormCode,
  ThesisFormInput,
  ThesisSettingInput,
  ThesisStageInput,
  WorkThesisFormInput,
  thesisRoutes,
  practiceJournalRoutes,
} from "./routes/index.ts";
export { KeyDatesBody, KeyDatesParams, keyDatesGet } from "./routes/index.ts";
export { sourceNotebookRoutes };
export { teachingTeamRoutes };
export { workTeamRoutes };
export { SourceProof, WORKING_CRITERION_IDS, WorkSourceRecord } from "./routes/index.ts";
export {
  AssignmentRubricInput,
  assignmentRubricRoutes,
  RUBRIC_LEVELS,
  RUBRIC_MAX_CRITERIA,
} from "./routes/index.ts";
export { SignedWithdrawalReceipt, WITHDRAWAL_RECEIPT_SCHEMA } from "./routes/index.ts";
export {
  NotificationId,
  NotificationsPage,
  NOTIFICATIONS_PAGE_SIZE,
  RevisionNotificationsPage,
  notificationsRoutes,
} from "./routes/index.ts";

export {
  ERROR_CATALOG_DATA,
  FALLBACK,
  INTERNAL,
  METHOD_NOT_ALLOWED,
  SHARED_ERROR_HEADERS,
  SHARED_ERRORS,
  TOO_MANY_REQUESTS,
};
export { SESSION_IDLE_EXPIRED } from "./routes/index.ts";
export {
  MentorNoteInput,
  MentorshipNoteParams,
  mentorNotesGet,
  mentorNotesPost,
} from "./routes/index.ts";
export { SIGN_IN_FAILURE, type SignInFailureCode } from "./routes/index.ts";
export { STAFF_AFFILIATION_SOURCES } from "./routes/index.ts";
export { ProblemReportInput, problemReportsPost } from "./routes/index.ts";
export {
  ADMIN_ACTION_KINDS,
  ADMIN_ACTIONS_PAGE,
  ADMIN_ACTOR_ROLES,
  ADMIN_SUBJECT_ROLES,
  AdminActionEntry,
  adminActionsGet,
  PROBLEM_REPORTS_PAGE,
  problemReportStatusPost,
  problemReportsGet,
  RoutedProblemReport,
} from "./routes/index.ts";
export { publicVerificationPost, sourceLookupPost };
export { workAttachmentGet, workAttachmentPost } from "./routes/index.ts";
export {
  CLIENT_APP_VERSION_PATTERN,
  CLIENT_CONTEXT_VALUES,
  MAX_COMMIT_BODY_BYTES,
} from "./routes/index.ts";
export { checkInventory } from "./check.ts";
export {
  CONTRACT_ONLY,
  INVENTORY,
  INVENTORY_SOURCE,
  PENDING,
  SERVER_SOURCES,
} from "./inventory.ts";
export * from "./schema/index.ts";
export {
  checkVectors,
  VectorFileSchema,
  type SchemaCheck,
  type Vector,
  type VectorFile,
} from "./vectors.ts";
export { isWorkId, WORK_ID_MAX, workIdFromPath } from "./work-id.ts";
// SRV-1803: the import contract (SRV-1801) for its first caller, the DOCX import.
export * from "./import/index.ts";

/** Every route of /api/v1 with a contract. */
export const ROUTES: readonly RouteContract[] = [
  ...platformRoutes,
  ...clientRoutes,
  ...authRoutes,
  ...webauthnRoutes,
  ...profileRoutes,
  ...staffAffiliationRoutes,
  ...evidenceRoutes,
  ...studentRoutes,
  ...studentSourcesRoutes,
  ...sourceNotebookRoutes,
  ...attachmentRoutes,
  ...sourceProofsRoutes,
  ...textCheckConfigRoutes,
  ...teacherSourcesRoutes,
  ...teacherWorkRoutes,
  ...originCompositionRoutes,
  ...assistantMatchRoutes,
  ...inputRhythmRoutes,
  ...declarationRequiredRoutes,
  ...declarationQuestionRoutes,
  ...originThresholdsRoutes,
  ...teacherWorkingCriteriaRoutes,
  ...assignmentRubricRoutes,
  courseAggregateGet,
  pilotMetricsGet,
  retentionGet,
  ...institutionConfigRoutes,
  ...accessLogRoutes,
  ...deadlineExtensionRoutes,
  ...legalHoldRoutes,
  ...studentDataExportRoutes,
  ...submissionsRoutes,
  ...assignmentCopyRoutes,
  ...merlinRosterRoutes,
  ...rosterImportRoutes,
  ...merlinPackageRoutes,
  ...supportRoutes,
  problemReportsPost,
  // SRV-ADMIN-1 (NF-7 OA-7, OA-3): reports routed by kind, their state, the action log.
  problemReportsGet,
  problemReportStatusPost,
  ...adminActionLogRoutes,
  ...projectionRoutes,
  ...collaborationRoutes,
  ...consultationSlotRoutes,
  ...workInterviewRoutes,
  ...workInterviewPdfRoutes,
  ...mentorshipRoutes,
  ...mentorshipStudentRoutes,
  ...mentorshipConsultationRoutes,
  ...studentWorkRoutes,
  keyDatesGet,
  ...teachingTeamRoutes,
  ...workTeamRoutes,
  mentorNotesGet,
  mentorNotesPost,
  ...assistantRoutes,
  ...statementRoutes,
  ...liveRoutes,
  ...enrollmentRoutes,
  ...institutionRoutes,
  ...teacherRoutes,
  ...settingsRoutes,
  ...downloadsRoutes,
  ...receiptPdfRoutes,
  ...workExportRoutes,
  sourceLookupPost,
  ...publicVerificationRoutes,
  ...versionsRoutes,
  ...workExportDocxRoutes,
  ...portableRecordRoutes,
  ...submissionPackageRoutes,
  ...teacherSubmissionsBulkRoutes,
  workVersionGet,
  ...workMessagesRoutes,
  ...mentorshipFollowRoutes,
  ...selfNoteSealedRoutes,
  ...notificationsRoutes,
  ...commentsRoutes,
  ...workCompareRoutes,
  ...directEditRoutes,
  ...importRoutes,
  ...consultationRecordsRoutes,
  ...eventDisputesRoutes,
  ...facultyRulesRoutes,
  ...assistantSettingRoutes,
  ...workMilestonesRoutes,
  ...milestoneTemplateRoutes,
  ...workTemplateRoutes,
  ...assignmentTemplateRoutes,
  ...formatRulesRoutes,
  ...returnForRevisionRoutes,
  ...thesisRoutes,
  ...practiceJournalRoutes,
  ...opsRoutes,
  ...lateSubmissionRoutes,
];

/**
 * Every error the server may answer (S-1L.3, DAN-789): the errors of each
 * route, the shared ones, the fallback and 405. server/http answers only
 * these, and each key has a text in locales/hr.ts (server/http/problem.test.ts).
 */
export const SERVER_ERRORS: readonly ErrorSpec[] = Object.freeze([
  ...ROUTES.flatMap((route) => route.errors),
  ...SHARED_ERRORS,
  FALLBACK.error,
  METHOD_NOT_ALLOWED.error,
]);

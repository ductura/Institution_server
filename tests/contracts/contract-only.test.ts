// "Ugovoreno, nije implementirano" (DAN-803, Ductus#1836 c.6905207008 t. 0.1):
// a route in CONTRACT_ONLY has a contract that clients build against on the
// fake server, and no handler on this server. A handler mounted for it while
// it is still listed fails here, so the list cannot claim a route is unserved
// when it is served. A cross-area test (docs/server-map.md §2), as
// tests/contracts/evidence-domain.test.ts; outside server/http on purpose.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { CONTRACT_ONLY, ROUTES } from "../../server/contracts/index.ts";
import type {
  ActorReader,
  SettingsWriter,
  WebAuthnCredentials,
} from "../../server/database/index.ts";
import {
  AREA_NAMES,
  createInstitutionCourseRoutesFor,
  createInterfaceLocaleRoutesFor,
  createDownloadsManifestRoute,
  createWorkPdfRouteFor,
  createProblemReportRouteFor,
  createProblemReportsRouteFor,
  createPublicVerificationRouteFor,
  createInstitutionAssignmentRoutesFor,
  createAssignmentCurrentVersionRouteFor,
  createEnrollmentCodeStateRouteFor,
  createTeacherRoleRoutesFor,
  createAssignmentGradeRouteFor,
  createInstitutionGroupRoutesFor,
  createAdminCourseRouteFor,
  createRosterImportRoutesFor,
  createIsvuSourceRoutesFor,
  createTeacherReadRoutesFor,
  createTeacherSubmissionDetailRouteFor,
  createCourseAggregateRouteFor,
  createPilotMetricsRouteFor,
  createAnalysisRoutesFor,
  createRetentionRouteFor,
  createFacultyRuleRoutesFor,
  createAssistantSettingRouteFor,
  createInstitutionConfigRoutesFor,
  createWorkAccessRouteFor,
  createTeacherRosterRoutesFor,
  createDeadlineExtensionRoutesFor,
  createLegalHoldRoutesFor,
  createStudentDataExportRoutesFor,
  createSubmissionWithdrawalRoutesFor,
  createStudentDeadlineHistoryRouteFor,
  createAssignmentCopyRouteFor,
  createConsultationSlotRoutesFor,
  createWorkInterviewRoutesFor,
  createWorkInterviewPdfRouteFor,
  createMerlinRosterRoutesFor,
  createMerlinPackageRoutesFor,
  createAssistantRoutesFor,
  createStatementRoutesFor,
  createTeacherMentorshipRequestRoutesFor,
  createMentorshipRequestRoutesFor,
  createMentorshipStudentRoutesFor,
  createMentorshipConsultationRoutesFor,
  createStudentWorkRoutesFor,
  createKeyDatesRoutesFor,
  createTeachingTeamRoutesFor,
  createMentorNotesRoutesFor,
  createMentorWorkingStyleRoutesFor,
  createPracticeJournalRoutesFor,
  createWorkTeamRoutesFor,
  createPeerReviewRoutesFor,
  createQualitativeCodesRoutesFor,
  createWorkPlanRoutesFor,
  createQualitativeMaterialsRoutesFor,
  createQualitativeSegmentsRoutesFor,
  createThesisRoutesFor,
  createThesisTopicRoutesFor,
  createThesisCommitteeRoutesFor,
  createThesisOverviewRoutesFor,
  createLiveRoutesFor,
  createCollaborationCommentsRouteFor,
  createRevisionRequestsRouteFor,
  createConsultationRecordRoutesFor,
  createEventDisputeRoutesFor,
  createNotificationsRoutesFor,
  createAttachmentRoutesFor,
  createWorkMilestonesRoutesFor,
  createMilestoneTemplateRoutesFor,
  createAssignmentRubricRoutesFor,
  createAssignmentCodeTestsRoutesFor,
  createQuestionnaireRoutesFor,
  createWorkRubricRoutesFor,
  createWorkTemplateRoutesFor,
  createAssignmentTemplateRoutesFor,
  createFormatRulesRoutesFor,
  createReturnForRevisionRoutesFor,
  createSourceNotebookRoutesFor,
  createWorkVersionRouteFor,
  createWorkCompareRouteFor,
  createAcknowledgmentRouteFor,
  createSettingsReadRoutes,
  createSettingsValuesPutRoute,
  createStudentAssignmentWorkRouteFor,
  createStudentSubmissionRoutesFor,
  createReceiptPdfRoutesFor,
  createStudentNoticeRouteFor,
  createStaffAffiliationRouteFor,
  createStudentNotesRoutesFor,
  createSubmissionRouteFor,
  createProcessSummaryRouteFor,
  createStudentAccessLogRouteFor,
  createStudentAssignmentsRouteFor,
  createStudentWriteRoutesFor,
  createTeacherFastPathRouteFor,
  createWebAuthnRoutesFor,
  REFUSING_SIGNER,
  routesOf,
  STORAGE_NOT_CONFIGURED,
} from "../../server/http/index.ts";

// The operations of DAN-803 (c.6905207008, tables of PR1 to PR6), frozen: the
// task may add only these to CONTRACT_ONLY, and each of them that has a
// contract and no handler must be there. After the task the list only shrinks.
// (`submission.submit.post`: the table's `submission.post` has no name part,
// which checkRoute refuses.)
/**
 * The course routes of DAN-852, mounted by the entry point since 852-5a, and
 * the student, version and work language routes on the same front
 * (Ductus#2028, w1119o).
 */
const INSTITUTION_COURSE_ROUTES = [
  "institution.courses.post",
  "institution.enrollment-code.post",
  "institution.enrollment-code-revocation.post",
  "institution.student-removal.post",
  "institution.student-return.post",
  "institution.work-language.post",
  "institution.student-work-language.post",
  "institution.work-work-language.post",
  "institution.work-work-language.get",
] as const;

/** The teacher's reads (Ductus#2028, w1119o), in the order of their factory. */
const TEACHER_READ_ROUTES = [
  "teacher.courses.get",
  "teacher.access.get",
  "teacher.mentorships.get",
  "teacher.mentorship.get",
  "teacher.submissions.get",
  "teacher.assignment-submissions.post",
] as const;

const TEACHER_ROSTER_ROUTES = [
  "teacher.course-students.get",
  "teacher.assignment-overview.get",
  "teacher.assignment-follow-up.get",
];

export const DAN_803: readonly string[] = [
  "student.assignments.get",
  "support.problem-report.post",
  ...["live.document.get", "live.document.put", "collaboration.comments.post"],
  ...["collaboration.revision-requests.post", "projection.process-summary.post"],
  ...["institution.enrollments.post", "institution.acknowledgment.post"],
  ...["institution.work-language.post", "institution.student-work-language.post"],
  "institution.work-work-language.post",
  "institution.work-work-language.get",
  ...["teacher.courses.get", "teacher.submissions.get", "teacher.mentorships.get"],
  ...["teacher.mentorship.get", "teacher.fast-path.post", "institution.courses.post"],
  ...["institution.course-assignments.post", "institution.enrollment-code.post"],
  ...["institution.enrollment-code-revocation.post", "institution.student-removal.post"],
  ...["institution.student-return.post", "institution.assignment-versions.post"],
  ...["institution.role-confirmation.post", "institution.role-revocation.post"],
  "submission.submit.post",
];

// The operations of DAN-806 (settings, Ductus#1836 c.6906291102), frozen the
// same way: contract now, handlers in S-1J-g.
export const DAN_806: readonly string[] = [
  "settings.catalogue.get",
  "settings.values.get",
  "settings.values.put",
];

// The operations of DAN-840-1 (WebAuthn, Ductus#1836 c.6934850911: contract
// now, handlers in 840-3), frozen the same way.
export const DAN_840: readonly string[] = [
  "auth.webauthn-challenge.post",
  "auth.webauthn-registration.post",
  "auth.webauthn-assertion.post",
];

// The operations of DAN-903 (teacher reads, Ductus#1836 c.6947962506 and
// c.6948165042: contract now, handlers later), frozen the same way.
export const DAN_903: readonly string[] = [
  "teacher.assignment-submissions.post",
  "teacher.access.get",
];

// The operations of DAN-904 (the student's access log, Ductus#1836
// c.6948327193: contract now, handler later), frozen the same way.
export const DAN_904: readonly string[] = ["student.access-log.get"];

// The operation of DAN-989-1 (the student's work state, Ductus#1836
// c.6956258999: contract now, handler in 989-2), frozen the same way.
export const DAN_989: readonly string[] = ["student.assignment-work.get"];

// The operation of DAN-931 (the download manifest, Ductus#1836 c.6960799782:
// contract now, handler in DAN-932), frozen the same way.
export const DAN_931: readonly string[] = ["downloads.manifest.get"];

// The operations of SRV-02 (the student's contracts of wave 2, Ductus#2028
// c.7008147932: contract now, handlers in SRV-10), frozen the same way.
export const SRV_02: readonly string[] = ["student.enrollments.post", "student.notice-read.post"];

// The operations of SRV-03 (the administrator's course and the groups of wave
// 4, Ductus#2028 c.7008147932: contract now, handlers in SRV-12 and SRV-15).
export const SRV_03: readonly string[] = [
  "institution.admin-courses.post",
  "institution.course-groups.get",
  "institution.course-groups.post",
  "institution.course-group-teachers.post",
];

// The operations of UGOVORI-API (every /api/v1 contract ahead of its handler,
// Ductus#2028 c.7023902063; scope c.7022752457), frozen the same way.
export const UGOVORI_API: readonly string[] = [
  "student.notice.get",
  "institution.assignment.get",
  "institution.enrollment-code-state.get",
];

// SRV-19 defines the wire shapes ahead of the handlers in SRV-22 (mounted) and SRV-24.
const SRV_19 = [
  "student.submission.get",
  "student.assignment-requirements.get",
  "student.submission-notes.get",
  "student.submission-notes.post",
];

// SRV-9B (✓ C-6, Ductus#2028 c.7041664094): the public check of a receipt,
// contract first, the route mounted by the entry point in part 4.
const SRV_9B = ["public.verification.post"];
const SRV_9C = ["student.receipt-pdf.get", "teacher.receipt-pdf.get"] as const;
const SRV_31 = ["teacher.mentorship-requests.get", "teacher.mentorship-request-decision.post"];
const SRV_1414 = ["mentorship.student-requests.get", "mentorship.student-mentor-candidates.get"];
const SRV_MENTOR_1 = [
  "mentorship.open.post",
  "mentorship.student-mentorships.get",
  "notifications.mentorship-opened.list.get",
  "work.consultation-slot-details.get",
  "work.consultation-slot-requests.post",
  "work.consultation-slot-close.post",
  "work.consultation-tasks.get",
  "work.consultation-tasks.post",
  "work.consultation-task-mark.post",
];
const SRV_1412 = ["student-work.start.post", "student-work.works.get"];
const SRV_1407 = [
  "mentorship.requests.post",
  "mentorship.request-approve.post",
  "mentorship.request-decline.post",
  "mentorship.request-withdraw.post",
];
const SRV_1408 = [
  "institution.teaching-team.get",
  "institution.teaching-team-view.get",
  "institution.teaching-team-candidates.get",
  "institution.teaching-team.post",
  "institution.teaching-group-members.put",
];
const SRV_1413 = ["mentorship.notes.get", "mentorship.notes.post"];
const SRV_F4_MEN_R09 = ["mentorship.working-style.get", "mentorship.working-style.put"];
// SRV-V19-DNEVNIK-RUTE: the six routes of the practice journal.
const SRV_V19_DNEVNIK = [
  "practice.placements.post",
  "practice.placements.get",
  "practice.entries.get",
  "practice.entries.post",
  "practice.signoffs.post",
  "practice.signoffs.get",
];
// SRV-V19-GRUPA-RUTE: the nine routes of the work teams.
const SRV_V19_GRUPA = [
  "institution.assignment-team-setting.put",
  "institution.assignment-team-setting.get",
  "student.work-team.get",
  "student.work-team.post",
  "teacher.work-teams.get",
  "teacher.work-teams.post",
  "teacher.work-team-member.post",
  "student.work-team-contribution.get",
  "teacher.work-team-contribution.get",
];
// SRV-V19-RECENZIJA-RUTE: the nine routes of the anonymous peer review.
const SRV_V19_RECENZIJA = [
  "peer-review.round.put",
  "peer-review.round.get",
  "peer-review.allocate.post",
  "peer-review.teacher-overview.get",
  "peer-review.review-withdrawal.post",
  "student.peer-review-tasks.get",
  "student.peer-review-work.get",
  "student.peer-review.post",
  "student.peer-reviews-received.get",
];
// SRV-V18-KODIRANJE-SIFRARNIK: the four routes of the codebook of qualitative coding.
const SRV_V18_SIFRARNIK = [
  "student.qual-codes.get",
  "student.qual-codes.post",
  "student.qual-code.patch",
  "student.qual-code.delete",
];
// SRV-V18-KODIRANJE-GRADIVO: the four routes of the material of qualitative coding.
const SRV_V18_GRADIVO = [
  "student.qual-materials.get",
  "student.qual-materials.post",
  "student.qual-material.get",
  "student.qual-material.delete",
];
// SRV-V18-KODIRANJE-OZNAKE: the passages marked in a material and the export of the coding.
const SRV_V18_OZNAKE = [
  "student.qual-segments.get",
  "student.qual-segments.post",
  "student.qual-segment.delete",
  "student.qual-export.get",
];
// SRV-F4-PM2-R15: the two routes of the plan of a work.
const SRV_F4_PLAN = ["work.plan.get", "work.plan.put"];
const SRV_MENTOR_2 = [
  "institution.thesis-forms.get",
  "institution.thesis-forms.post",
  "institution.thesis-settings.get",
  "institution.thesis-settings.put",
  "work.thesis-forms.get",
  "work.thesis-form.put",
  "work.mentor-consent.get",
  "work.mentor-consent.put",
  "work.thesis-stage.get",
  "work.thesis-stage.put",
];
const SRV_V16_TEMA = [
  "work.thesis-topic.get",
  "work.thesis-topic.put",
  "work.thesis-topic-decision.post",
];
const SRV_V16_POVJERENSTVO = ["work.thesis-committee.get", "work.thesis-committee.put"];
const SRV_V16_POPIS = ["institution.thesis-overview.get"];
// The teacher contracts of SRV-27 (Ductus#2028 c.7009405737): contract now,
// handlers in SRV-29, SRV-30 and SRV-31.
const SRV_27 = [
  "teacher.course-students.get",
  "teacher.assignment-overview.get",
  "teacher.assignment-follow-up.get",
  "teacher.submission-receipt.get",
  ...SRV_31,
] as const;

// The operation of DAN-843-1 (the operator's read of events, Ductus#2028
// OPSEG c.6979453212: contract now, handler in 843-2), frozen the same way.
export const DAN_843: readonly string[] = ["ops.events.get"];

/** Every route a task has put on the list; nothing else may be there. */
const FROZEN: readonly string[] = [
  ...[...DAN_803, ...DAN_806, ...DAN_840, ...DAN_903, ...DAN_904],
  ...[...DAN_989, ...DAN_931, ...SRV_02, ...SRV_03, ...UGOVORI_API, ...SRV_19, ...SRV_9B],
  ...SRV_9C,
  ...SRV_27,
  ...DAN_843,
];

// Routes the entry point mounts itself, over a database the areas cannot be
// given (DAN-826-2b): the exact call server/server.ts must hold, and the
// route id its factory gives. A call with another writer, or one commented
// out, is not a mount.
const NO_WRITER: SettingsWriter = { setValue: () => Promise.reject(new Error("no writer")) };
const NO_ACTOR = { withActor: () => Promise.reject(new Error("no database")) };
const NO_READER = {} as ActorReader;
const NO_WEBAUTHN = { ...NO_ACTOR, webauthnCredentials: {} as WebAuthnCredentials };
const ENTRY_MOUNTED: readonly { call: string; ids: string[]; routes: () => string[] }[] = [
  {
    call: "createWorkPdfRouteFor(databases.main, process.env.DUCTURA_PDF_RENDERER_ORIGIN)",
    ids: ["work.export-pdf.get"],
    routes: () => [createWorkPdfRouteFor(NO_ACTOR, undefined).contract.id],
  },
  {
    call: "createStudentAssignmentWorkRouteFor(databases.main)",
    ids: ["student.assignment-work.get"],
    routes: () => [createStudentAssignmentWorkRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "createStudentNotesRoutesFor(databases.main)",
    ids: ["student.submission-notes.get", "student.submission-notes.post"],
    routes: () => createStudentNotesRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createSettingsValuesPutRoute({ writer: databases.main.settingsWriter })",
    ids: ["settings.values.put"],
    routes: () => [createSettingsValuesPutRoute({ writer: NO_WRITER }).contract.id],
  },
  {
    call: "createSettingsReadRoutes(databases.main)",
    ids: ["settings.catalogue.get", "settings.values.get"],
    routes: () =>
      createSettingsReadRoutes({ ...NO_ACTOR, actorReader: NO_READER }).map(
        (route) => route.contract.id,
      ),
  },
  {
    call: "createInterfaceLocaleRoutesFor(databases.main)",
    ids: ["profile.interface-locale.get", "profile.interface-locale.post"],
    routes: () => createInterfaceLocaleRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // DAN-932: the download manifest over the release configuration built in.
    call: "createDownloadsManifestRoute()",
    ids: ["downloads.manifest.get"],
    routes: () => [createDownloadsManifestRoute().contract.id],
  },
  {
    // DAN-851-2d2a: the problem report over the main database.
    call: "createProblemReportRouteFor(databases.main)",
    ids: ["support.problem-report.post"],
    routes: () => [createProblemReportRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "createProblemReportsRouteFor(databases.main)",
    ids: ["support.problem-reports.post"],
    routes: () => [createProblemReportsRouteFor(NO_ACTOR).contract.id],
  },
  {
    // DAN-852-5a: the three course routes over the main database.
    call: "createInstitutionCourseRoutesFor(databases.main)",
    ids: [...INSTITUTION_COURSE_ROUTES],
    routes: () => createInstitutionCourseRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createEnrollmentCodeStateRouteFor(databases.main)",
    ids: ["institution.enrollment-code-state.get"],
    routes: () => [createEnrollmentCodeStateRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-ULOGA-POTVRDA-OPOZIV: the administrator confirms and revokes a teacher role.
    call: "createTeacherRoleRoutesFor(databases.main)",
    ids: ["institution.role-confirmation.post", "institution.role-revocation.post"],
    routes: () => createTeacherRoleRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-14: a course's new assignment and an assignment's next version.
    call: "createInstitutionAssignmentRoutesFor(databases.main)",
    ids: ["institution.course-assignments.post", "institution.assignment-versions.post"],
    routes: () => createInstitutionAssignmentRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createAssignmentCurrentVersionRouteFor(databases.main)",
    ids: ["institution.assignment.get"],
    routes: () => [createAssignmentCurrentVersionRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "createAssignmentGradeRouteFor(databases.main)",
    ids: ["teacher.assignment-grade.get"],
    routes: () => [createAssignmentGradeRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-12: the administrator's course over the main database.
    call: "createAdminCourseRouteFor(databases.main)",
    ids: ["institution.admin-courses.post"],
    routes: () => [createAdminCourseRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-ADMIN-2: the administrator's roster import, preview and confirmation.
    call: "...createRosterImportRoutesFor(databases.main)",
    ids: ["institution.roster-imports.post", "institution.roster-import-confirm.post"],
    routes: () => createRosterImportRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-V22-ISVU-POPIS: the trial ISVU source's courses and the preview of a course's students.
    call: "...createIsvuSourceRoutesFor(databases.main, { local: SECURITY.local })",
    ids: ["institution.isvu-courses.get", "institution.isvu-roster-imports.post"],
    routes: () => createIsvuSourceRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-15: a course's seminar groups and their teachers.
    call: "createInstitutionGroupRoutesFor(databases.main)",
    ids: [
      "institution.course-groups.get",
      "institution.course-groups.post",
      "institution.course-group-teachers.post",
    ],
    routes: () => createInstitutionGroupRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-13: the teacher's courses and access over the main database.
    call: "createTeacherReadRoutesFor(databases.main)",
    ids: [...TEACHER_READ_ROUTES],
    routes: () => createTeacherReadRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createCourseAggregateRouteFor(databases.main)",
    ids: ["course.aggregate.get"],
    routes: () => [createCourseAggregateRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "...createFacultyRuleRoutesFor(databases.main)",
    ids: ["institution.faculty-rules.get", "institution.faculty-rules.post"],
    routes: () => createFacultyRuleRoutesFor(NO_ACTOR).map((r) => r.contract.id),
  },
  {
    call: "createAssistantSettingRouteFor(databases.main)",
    ids: ["institution.assistant-setting.get"],
    routes: () => [createAssistantSettingRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "...createInstitutionConfigRoutesFor(databases.main)",
    ids: ["institution.config.get", "institution.config-versions.post"],
    routes: () => createInstitutionConfigRoutesFor(NO_ACTOR).map((r) => r.contract.id),
  },
  {
    call: "...createAnalysisRoutesFor(databases.main, { enabled: ANALYSIS_LOCAL })",
    ids: ["analysis.catalogue.get", "analysis.runs.post"],
    routes: () => createAnalysisRoutesFor(NO_ACTOR).map((r) => r.contract.id),
  },
  {
    call: "createPilotMetricsRouteFor(databases.main)",
    ids: ["ops.pilot-metrics.get"],
    routes: () => [createPilotMetricsRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "createRetentionRouteFor(databases.main)",
    ids: ["institution.retention.get"],
    routes: () => [createRetentionRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "createWorkAccessRouteFor(databases.main)",
    ids: ["work.access.get"],
    routes: () => [createWorkAccessRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "createTeacherRosterRoutesFor(databases.main)",
    ids: TEACHER_ROSTER_ROUTES,
    routes: () => createTeacherRosterRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createTeacherSubmissionDetailRouteFor(databases.main)",
    ids: ["teacher.submission-detail.get"],
    routes: () => [createTeacherSubmissionDetailRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-1108: the deadline extensions of an assignment over the main database.
    call: "...createDeadlineExtensionRoutesFor(databases.main)",
    ids: [
      "teacher.deadline-extensions.get",
      "teacher.deadline-extension.post",
      // SRV-NF4-IZNIMKA-ZAPIS: the late-submission exceptions share the port.
      "teacher.late-exceptions.get",
      "teacher.late-exception.post",
      "student.late-exceptions.get",
    ],
    routes: () => createDeadlineExtensionRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-1306: the legal holds of the institution over the main database.
    call: "...createLegalHoldRoutesFor(databases.main)",
    ids: [
      "institution.legal-holds.get",
      "institution.legal-holds.post",
      "institution.legal-hold-release.post",
    ],
    routes: () => createLegalHoldRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-1308: the student data export through the registry office over the main database.
    call: "...createStudentDataExportRoutesFor(databases.main, process.env, process.cwd())",
    ids: [
      "institution.student-data-exports.get",
      "institution.student-data-export-students.get",
      "institution.student-data-exports.post",
      "institution.student-data-exports-approve.post",
      "student.data-export.get",
    ],
    routes: () =>
      createStudentDataExportRoutesFor(NO_ACTOR as never, {}, ".").map(
        (route) => route.contract.id,
      ),
  },
  {
    call: "createStudentDeadlineHistoryRouteFor(databases.main)",
    ids: ["student.deadline-history.get"],
    routes: () => [createStudentDeadlineHistoryRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-1903: withdrawal, the histories and the teacher's switch, with the submission's signer.
    call: "...createSubmissionWithdrawalRoutesFor(databases.main, evidenceDeps)",
    ids: [
      "student.submission-withdrawal.post",
      "student.submission-withdrawal.get",
      "student.submission-history.get",
      "teacher.submission-history.get",
      "teacher.submission-withdrawal.get",
      "teacher.submission-withdrawal.post",
    ],
    routes: () =>
      createSubmissionWithdrawalRoutesFor(NO_ACTOR, { signer: REFUSING_SIGNER }).map(
        (route) => route.contract.id,
      ),
  },
  {
    // SRV-1904 (P-D4): copying an assignment over the main database.
    call: "createAssignmentCopyRouteFor(databases.main)",
    ids: ["teacher.assignment-copy.post"],
    routes: () => [createAssignmentCopyRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-1109: the Merlin roster of an assignment and its CSV over the main database.
    call: "...createMerlinRosterRoutesFor(databases.main)",
    ids: ["teacher.merlin-roster.get", "teacher.merlin-roster-csv.get"],
    routes: () => createMerlinRosterRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-1110: the Merlin package of an assignment and its download over the main database.
    call: "...createMerlinPackageRoutesFor(databases.main)",
    ids: [
      "teacher.merlin-packages.post",
      "teacher.merlin-package.get",
      "teacher.merlin-package-download.get",
    ],
    routes: () => createMerlinPackageRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-1204: the AI assistant proxy; no provider in production (ai_disabled).
    call: "...createAssistantRoutesFor(databases.main, assistantProvider)",
    ids: ["student.assistant-request.post", "student.assistant-conversation.get"],
    routes: () => createAssistantRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createStatementRoutesFor(databases.main)",
    ids: [
      "student.declaration.get",
      "student.declaration-conversations.get",
      "student.declaration.put",
      "student.declaration-attachments.post",
      "student.declaration-second.get",
      "student.declaration-second.put",
      "student.declaration-third.get",
      "student.declaration-third.put",
    ],
    routes: () => createStatementRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createTeacherMentorshipRequestRoutesFor(databases.main)",
    ids: SRV_31,
    routes: () =>
      createTeacherMentorshipRequestRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createConsultationSlotRoutesFor(databases.main)",
    ids: [
      "work.consultation-slots.get",
      "work.consultation-slots.post",
      "work.consultation-slots.patch",
    ],
    routes: () => createConsultationSlotRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createWorkInterviewRoutesFor(databases.main)",
    ids: [
      "work.interview.get",
      "work.interview-questions.post",
      "work.interview-questions.delete",
      "work.interview-invite.post",
      "work.interview-appointment.put",
      "work.interview-held.post",
      "work.interview-explanations.post",
      "work.interview-notes.post",
    ],
    routes: () => createWorkInterviewRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createWorkInterviewPdfRouteFor(databases.main)",
    ids: ["work.interview-pdf.get"],
    routes: () => [createWorkInterviewPdfRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "...createMentorshipRequestRoutesFor(databases.main)",
    ids: SRV_1407,
    routes: () => createMentorshipRequestRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createMentorshipStudentRoutesFor(databases.main)",
    ids: SRV_1414,
    routes: () => createMentorshipStudentRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createMentorshipConsultationRoutesFor(databases.main)",
    ids: SRV_MENTOR_1,
    routes: () => createMentorshipConsultationRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createStudentWorkRoutesFor(databases.main)",
    ids: SRV_1412,
    routes: () => createStudentWorkRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createKeyDatesRoutesFor(databases.main)",
    ids: ["mentorship.key-dates.get"],
    routes: () => createKeyDatesRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createTeachingTeamRoutesFor(databases.main)",
    ids: SRV_1408,
    routes: () => createTeachingTeamRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createMentorWorkingStyleRoutesFor(databases.main)",
    ids: SRV_F4_MEN_R09,
    routes: () => createMentorWorkingStyleRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createMentorNotesRoutesFor(databases.main)",
    ids: SRV_1413,
    routes: () => createMentorNotesRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createPracticeJournalRoutesFor(databases.main)",
    ids: SRV_V19_DNEVNIK,
    routes: () => createPracticeJournalRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createWorkTeamRoutesFor(databases.main)",
    ids: SRV_V19_GRUPA,
    routes: () => createWorkTeamRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createPeerReviewRoutesFor(databases.main)",
    ids: SRV_V19_RECENZIJA,
    routes: () => createPeerReviewRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createQualitativeCodesRoutesFor(databases.main)",
    ids: SRV_V18_SIFRARNIK,
    routes: () => createQualitativeCodesRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createQualitativeMaterialsRoutesFor(databases.main)",
    ids: SRV_V18_GRADIVO,
    routes: () => createQualitativeMaterialsRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createQualitativeSegmentsRoutesFor(databases.main)",
    ids: SRV_V18_OZNAKE,
    routes: () => createQualitativeSegmentsRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createWorkPlanRoutesFor(databases.main)",
    ids: SRV_F4_PLAN,
    routes: () => createWorkPlanRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createThesisRoutesFor(databases.main)",
    ids: SRV_MENTOR_2,
    routes: () => createThesisRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createThesisTopicRoutesFor(databases.main)",
    ids: SRV_V16_TEMA,
    routes: () => createThesisTopicRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createThesisCommitteeRoutesFor(databases.main)",
    ids: SRV_V16_POVJERENSTVO,
    routes: () => createThesisCommitteeRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createThesisOverviewRoutesFor(databases.main)",
    ids: SRV_V16_POPIS,
    routes: () => createThesisOverviewRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // Ductus#2028 (w1119o): the live view over the main database.
    call: "createLiveRoutesFor(databases.main)",
    ids: ["live.document.get", "live.document.put"],
    routes: () =>
      createLiveRoutesFor({ ...NO_ACTOR, actorReader: NO_READER }).map(
        (route) => route.contract.id,
      ),
  },
  {
    call: "createCollaborationCommentsRouteFor(databases.main)",
    ids: ["collaboration.comments.post"],
    routes: () => [createCollaborationCommentsRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "createRevisionRequestsRouteFor(databases.main)",
    ids: ["collaboration.revision-requests.post"],
    routes: () => [createRevisionRequestsRouteFor(NO_ACTOR).contract.id],
  },
  {
    call: "...createConsultationRecordRoutesFor(databases.main)",
    ids: [
      "work.consultation-records.get",
      "work.consultation-records.post",
      "work.consultation-additions.post",
    ],
    routes: () => createConsultationRecordRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createEventDisputeRoutesFor(databases.main)",
    ids: ["work.event-disputes.get", "work.event-disputes.post"],
    routes: () => createEventDisputeRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createNotificationsRoutesFor(databases.main, reminderCooldown)",
    ids: [
      "notifications.list.get",
      "notifications.returned-for-revision.list.get",
      "notifications.messages-and-slots.list.get",
      "notifications.read.post",
    ],
    routes: () => createNotificationsRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createAttachmentRoutesFor(databases.main, process.env, process.cwd())",
    ids: ["work.attachments.post", "work.attachments.get"],
    routes: () =>
      createAttachmentRoutesFor(NO_ACTOR as never, {}, ".").map((route) => route.contract.id),
  },
  {
    call: "...createWorkMilestonesRoutesFor(databases.main)",
    ids: [
      "work.milestones.get",
      "work.milestones.patch",
      "work.milestones.delete",
      "work.milestone-states.get",
      "work.milestones.details.patch",
      "work.milestones.submit.post",
      "work.milestones.request-revision.post",
      "work.milestones.approve.post",
    ],
    routes: () => createWorkMilestonesRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createMilestoneTemplateRoutesFor(databases.main)",
    ids: [
      "institution.milestone-template.get",
      "institution.milestone-template.put",
      "work.milestone-plan.get",
      "work.milestone-plan.add.post",
      "work.milestone-plan.apply-template.post",
    ],
    routes: () => createMilestoneTemplateRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createAssignmentRubricRoutesFor(databases.main)",
    ids: [
      "teacher.assignment-rubric.get",
      "teacher.assignment-rubric.put",
      "student.assignment-rubric.get",
    ],
    routes: () => createAssignmentRubricRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createAssignmentCodeTestsRoutesFor(databases.main)",
    ids: [
      "teacher.assignment-code-tests.get",
      "teacher.assignment-code-tests.put",
      "student.assignment-code-tests.get",
    ],
    routes: () => createAssignmentCodeTestsRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createQuestionnaireRoutesFor(databases.main)",
    ids: [
      "teacher.questionnaires.get",
      "teacher.questionnaires.post",
      "teacher.questionnaire.get",
      "teacher.questionnaire.patch",
      "teacher.questionnaire-state.post",
    ],
    routes: () => createQuestionnaireRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createWorkRubricRoutesFor(databases.main)",
    ids: ["teacher.work-rubric.get", "teacher.work-rubric-mark.put"],
    routes: () => createWorkRubricRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createWorkTemplateRoutesFor(databases.main)",
    ids: ["institution.work-template.get", "institution.work-template.put"],
    routes: () => createWorkTemplateRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createAssignmentTemplateRoutesFor(databases.main)",
    ids: ["teacher.assignment-template.put", "student.assignment-template.get"],
    routes: () => createAssignmentTemplateRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createFormatRulesRoutesFor(databases.main)",
    ids: ["student.assignment-format-rules.get"],
    routes: () => createFormatRulesRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "...createReturnForRevisionRoutesFor(databases.main)",
    ids: ["work.return-for-revision.post"],
    routes: () => createReturnForRevisionRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createSourceNotebookRoutesFor(databases.main)",
    ids: [
      "work.source-notes.get",
      "work.source-notes.post",
      "work.source-notes.patch",
      "work.source-notes.delete",
    ],
    routes: () => createSourceNotebookRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    call: "createWorkVersionRouteFor(databases.main, evidenceDeps)",
    ids: ["work.version.get"],
    routes: () => [
      createWorkVersionRouteFor(NO_ACTOR, { payloads: STORAGE_NOT_CONFIGURED }).contract.id,
    ],
  },
  {
    call: "createWorkCompareRouteFor(databases.main, evidenceDeps)",
    ids: ["work.compare.get"],
    routes: () => [
      createWorkCompareRouteFor(NO_ACTOR, { payloads: STORAGE_NOT_CONFIGURED }).contract.id,
    ],
  },
  {
    call: "createAcknowledgmentRouteFor(databases.main)",
    ids: ["institution.acknowledgment.post"],
    routes: () => [createAcknowledgmentRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-18: a student's submission over the process's signer and storage.
    call: "createSubmissionRouteFor(databases.main, evidenceDeps)",
    ids: ["submission.submit.post"],
    routes: () => [
      createSubmissionRouteFor(
        { ...NO_ACTOR, actorReader: {} as ActorReader },
        { signer: REFUSING_SIGNER, payloads: STORAGE_NOT_CONFIGURED },
      ).contract.id,
    ],
  },
  {
    // SRV-23: the process summary over the process's storage and the thresholds of the environment.
    call: "createProcessSummaryRouteFor(databases.main, evidenceDeps, process.env)",
    ids: ["projection.process-summary.post"],
    routes: () => [
      createProcessSummaryRouteFor(NO_ACTOR, { payloads: STORAGE_NOT_CONFIGURED }, {}).contract.id,
    ],
  },
  {
    // SRV-22: the student's submission state and word range over the main database.
    call: "...createStudentSubmissionRoutesFor(databases.main)",
    ids: [
      "student.submission.get",
      "student.assignment-requirements.get",
      "teacher.submission-receipt.get",
      // SRV-NF1-PREDANO: the same states for every own assignment at once.
      "student.assignment-submissions.get",
      "student.submission-confirmation-code.get",
      "teacher.submission-confirmation-code.get",
    ],
    routes: () => createStudentSubmissionRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
  {
    // SRV-9C, INT-31: the receipt PDF over the main database and the pipeline's origin.
    call: "...createReceiptPdfRoutesFor(databases.main, APP_ORIGIN)",
    ids: [...SRV_9C],
    routes: () => createReceiptPdfRoutesFor(NO_ACTOR, null).map((route) => route.contract.id),
  },
  {
    // SRV-NG: the notice of the current version over the main database.
    call: "createStudentNoticeRouteFor(databases.main)",
    ids: ["student.notice.get"],
    routes: () => [createStudentNoticeRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-1403: the caller's own staff affiliation over the main database.
    call: "createStaffAffiliationRouteFor(databases.main)",
    ids: ["profile.staff-affiliation.get"],
    routes: () => [createStaffAffiliationRouteFor(NO_ACTOR).contract.id],
  },
  {
    // SRV-9B: the public check of a receipt over the main database.
    call: "createPublicVerificationRouteFor(databases.main)",
    ids: ["public.verification.post"],
    routes: () => [createPublicVerificationRouteFor(NO_ACTOR).contract.id],
  },
  {
    // DAN-840-3f1: over the same origin as the pipeline (server.ts APP_ORIGIN).
    call: "createWebAuthnRoutesFor(databases.main, APP_ORIGIN)",
    ids: [
      "auth.webauthn-challenge.post",
      "auth.webauthn-registration.post",
      "auth.webauthn-assertion.post",
    ],
    routes: () => createWebAuthnRoutesFor(NO_WEBAUTHN, null).map((route) => route.contract.id),
  },
  {
    // SRV-8E: the teacher's fast path, mounted with SRV-8E and left on the list.
    call: "createTeacherFastPathRouteFor(databases.main, evidenceDeps, process.env)",
    ids: ["teacher.fast-path.post"],
    routes: () => [
      createTeacherFastPathRouteFor(NO_ACTOR, { payloads: STORAGE_NOT_CONFIGURED }, {}).contract.id,
    ],
  },
  {
    // Faza 3 readiness: the student's assignment list over the main database (DAN-803).
    call: "createStudentAssignmentsRouteFor(databases.main)",
    ids: ["student.assignments.get"],
    routes: () => [createStudentAssignmentsRouteFor(NO_ACTOR).contract.id],
  },
  {
    // Faza 3 readiness: the student's own access log over the main database (DAN-904).
    call: "createStudentAccessLogRouteFor(databases.main)",
    ids: ["student.access-log.get"],
    routes: () => [createStudentAccessLogRouteFor(NO_ACTOR).contract.id],
  },
  {
    // Faza 3 readiness: enrolment by code and the notice read (SRV-02).
    call: "...createStudentWriteRoutesFor(databases.main)",
    ids: [...SRV_02],
    routes: () => createStudentWriteRoutesFor(NO_ACTOR).map((route) => route.contract.id),
  },
];
const ENTRY_TEXT = readFileSync(new URL("../../server/server.ts", import.meta.url), "utf8");

/** The text of an entry point without its comments. */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");

/** The ids of ENTRY_MOUNTED whose exact call is in the entry text. */
export function entryMounted(entry: string): string[] {
  const text = code(entry);
  return ENTRY_MOUNTED.filter((row) => text.includes(row.call)).flatMap((row) => row.ids);
}

const mounted = (): string[] => [
  ...routesOf(AREA_NAMES).map((route) => route.contract.id),
  ...entryMounted(ENTRY_TEXT),
];

/** Every problem of a CONTRACT_ONLY list against the routes and the mounted ids. */
export function contractOnlyProblems(
  list: readonly string[],
  routeIds: readonly string[],
  mountedIds: readonly string[],
): string[] {
  const problems: string[] = [];
  if (new Set(list).size !== list.length) problems.push("duplicate id");
  for (const id of list) {
    if (!FROZEN.includes(id)) problems.push(`${id}: not a contract-only route of a task`);
    if (!routeIds.includes(id)) problems.push(`${id}: no contract`);
    if (mountedIds.includes(id)) problems.push(`${id}: mounted`);
  }
  for (const id of FROZEN)
    if (routeIds.includes(id) && !mountedIds.includes(id) && !list.includes(id))
      problems.push(`${id}: contract without a handler, not in CONTRACT_ONLY`);
  return problems;
}

describe("CONTRACT_ONLY", () => {
  const ids = ROUTES.map((route) => route.id);

  it("is exactly the DAN-803, DAN-806, DAN-840, DAN-903, DAN-904, DAN-989 and DAN-931 routes with a contract and no handler", () => {
    expect(new Set(DAN_803).size).toBe(28);
    expect(new Set(DAN_806).size).toBe(3);
    expect(new Set(DAN_840).size).toBe(3);
    expect(DAN_806.filter((id) => DAN_803.includes(id))).toEqual([]);
    expect(DAN_840.filter((id) => DAN_803.includes(id) || DAN_806.includes(id))).toEqual([]);
    expect(contractOnlyProblems(CONTRACT_ONLY, ids, mounted())).toEqual([]);
  });

  // Fixed inputs, not the live ROUTES, so these stay true as DAN-803 adds routes.
  const routeIds = ["auth.login.get", "student.assignments.get", "teacher.courses.get"];

  it("refuses a route outside both tasks, a route without contract, a duplicate and a mounted one", () => {
    expect(
      contractOnlyProblems(
        ["teacher.courses.get", "auth.login.get", "live.document.get", "teacher.courses.get"],
        routeIds,
        ["teacher.courses.get", "student.assignments.get"],
      ),
    ).toEqual([
      "duplicate id",
      "teacher.courses.get: mounted",
      "auth.login.get: not a contract-only route of a task",
      "live.document.get: no contract",
      "teacher.courses.get: mounted",
    ]);
  });

  it("refuses a DAN-803 or DAN-806 contract left out of the list", () => {
    expect(contractOnlyProblems([], [...routeIds, "settings.values.put"], [])).toEqual([
      "student.assignments.get: contract without a handler, not in CONTRACT_ONLY",
      "teacher.courses.get: contract without a handler, not in CONTRACT_ONLY",
      "settings.values.put: contract without a handler, not in CONTRACT_ONLY",
    ]);
    expect(
      contractOnlyProblems(["student.assignments.get", "teacher.courses.get"], routeIds, []),
    ).toEqual([]);
    const withoutSettings = CONTRACT_ONLY.filter((id) => !DAN_806.includes(id));
    // Compared as sets: the problems follow the order of FROZEN, in which the
    // work language routes come before the course routes.
    expect(contractOnlyProblems(withoutSettings, ids, []).sort()).toEqual(
      // With nothing mounted, the WebAuthn routes (mounted since 840-3f1), the
      // problem report (851-2d2a), the course routes (852-5a), the download
      // manifest (DAN-932), the teacher's reads (SRV-13) and the assignment
      // routes (SRV-14), group routes (SRV-15), student work state (SRV-AWG)
      // and submission (SRV-18), process summary (SRV-23), submission state and
      // requirements (SRV-22) and the public check (SRV-9B) are missing too.
      [
        ...["support.problem-report.post", "projection.process-summary.post"],
        ...TEACHER_READ_ROUTES,
        ...TEACHER_ROSTER_ROUTES,
        ...SRV_31,
        ...INSTITUTION_COURSE_ROUTES,
        "institution.enrollment-code-state.get",
        ...["institution.role-confirmation.post", "institution.role-revocation.post"],
        "institution.course-assignments.post",
        "institution.assignment-versions.post",
        "submission.submit.post",
        ...[...DAN_806, ...DAN_840, ...DAN_989, ...DAN_931],
        ...["institution.admin-courses.post", "institution.course-groups.get"],
        ...["institution.course-groups.post", "institution.course-group-teachers.post"],
        "institution.assignment.get",
        ...["student.submission.get", "student.assignment-requirements.get"],
        "teacher.submission-receipt.get",
        "student.notice.get",
        "student.submission-notes.get",
        "student.submission-notes.post",
        "live.document.get",
        "live.document.put",
        "collaboration.comments.post",
        "collaboration.revision-requests.post",
        "institution.acknowledgment.post",
        "public.verification.post",
        ...SRV_9C,
        ...["teacher.fast-path.post", "student.assignments.get", "student.access-log.get"],
        ...SRV_02,
      ]
        .map((id) => `${id}: contract without a handler, not in CONTRACT_ONLY`)
        .sort(),
    );
  });

  it("refuses a DAN-806 route that is mounted", () => {
    for (const id of DAN_806) {
      expect(contractOnlyProblems([...CONTRACT_ONLY, id], ids, mounted())).toEqual([
        `${id}: mounted`,
      ]);
    }
  });
});

describe("routes the entry point mounts itself", () => {
  it("server.ts mounts the settings PUT, the interface language and WebAuthn over the main database", () => {
    expect(entryMounted(ENTRY_TEXT)).toEqual([
      "work.export-pdf.get",
      "student.assignment-work.get",
      "student.submission-notes.get",
      "student.submission-notes.post",
      "settings.values.put",
      "settings.catalogue.get",
      "settings.values.get",
      "profile.interface-locale.get",
      "profile.interface-locale.post",
      "downloads.manifest.get",
      "support.problem-report.post",
      "support.problem-reports.post",
      ...INSTITUTION_COURSE_ROUTES,
      "institution.enrollment-code-state.get",
      "institution.role-confirmation.post",
      "institution.role-revocation.post",
      "institution.course-assignments.post",
      "institution.assignment-versions.post",
      "institution.assignment.get",
      "teacher.assignment-grade.get",
      "institution.admin-courses.post",
      "institution.roster-imports.post",
      "institution.roster-import-confirm.post",
      "institution.isvu-courses.get",
      "institution.isvu-roster-imports.post",
      "institution.course-groups.get",
      "institution.course-groups.post",
      "institution.course-group-teachers.post",
      ...TEACHER_READ_ROUTES,
      "course.aggregate.get",
      "institution.faculty-rules.get",
      "institution.faculty-rules.post",
      "institution.assistant-setting.get",
      "institution.config.get",
      "institution.config-versions.post",
      "analysis.catalogue.get",
      "analysis.runs.post",
      "ops.pilot-metrics.get",
      "institution.retention.get",
      "work.access.get",
      ...TEACHER_ROSTER_ROUTES,
      "teacher.submission-detail.get",
      "teacher.deadline-extensions.get",
      "teacher.deadline-extension.post",
      "teacher.late-exceptions.get",
      "teacher.late-exception.post",
      "student.late-exceptions.get",
      "institution.legal-holds.get",
      "institution.legal-holds.post",
      "institution.legal-hold-release.post",
      "institution.student-data-exports.get",
      "institution.student-data-export-students.get",
      "institution.student-data-exports.post",
      "institution.student-data-exports-approve.post",
      "student.data-export.get",
      "student.deadline-history.get",
      "student.submission-withdrawal.post",
      "student.submission-withdrawal.get",
      "student.submission-history.get",
      "teacher.submission-history.get",
      "teacher.submission-withdrawal.get",
      "teacher.submission-withdrawal.post",
      "teacher.assignment-copy.post",
      "teacher.merlin-roster.get",
      "teacher.merlin-roster-csv.get",
      "teacher.merlin-packages.post",
      "teacher.merlin-package.get",
      "teacher.merlin-package-download.get",
      "student.assistant-request.post",
      "student.assistant-conversation.get",
      "student.declaration.get",
      "student.declaration-conversations.get",
      "student.declaration.put",
      "student.declaration-attachments.post",
      "student.declaration-second.get",
      "student.declaration-second.put",
      "student.declaration-third.get",
      "student.declaration-third.put",
      ...SRV_31,
      "work.consultation-slots.get",
      "work.consultation-slots.post",
      "work.consultation-slots.patch",
      "work.interview.get",
      "work.interview-questions.post",
      "work.interview-questions.delete",
      "work.interview-invite.post",
      "work.interview-appointment.put",
      "work.interview-held.post",
      "work.interview-explanations.post",
      "work.interview-notes.post",
      "work.interview-pdf.get",
      ...SRV_1407,
      ...SRV_1414,
      ...SRV_MENTOR_1,
      ...SRV_1412,
      "mentorship.key-dates.get",
      ...SRV_1408,
      ...SRV_F4_MEN_R09,
      ...SRV_1413,
      ...SRV_V19_DNEVNIK,
      ...SRV_V19_GRUPA,
      ...SRV_V19_RECENZIJA,
      ...SRV_V18_SIFRARNIK,
      ...SRV_V18_GRADIVO,
      ...SRV_V18_OZNAKE,
      ...SRV_F4_PLAN,
      ...SRV_MENTOR_2,
      ...SRV_V16_TEMA,
      ...SRV_V16_POVJERENSTVO,
      ...SRV_V16_POPIS,
      "live.document.get",
      "live.document.put",
      "collaboration.comments.post",
      "collaboration.revision-requests.post",
      "work.consultation-records.get",
      "work.consultation-records.post",
      "work.consultation-additions.post",
      "work.event-disputes.get",
      "work.event-disputes.post",
      "notifications.list.get",
      "notifications.returned-for-revision.list.get",
      "notifications.messages-and-slots.list.get",
      "notifications.read.post",
      "work.attachments.post",
      "work.attachments.get",
      "work.milestones.get",
      "work.milestones.patch",
      "work.milestones.delete",
      "work.milestone-states.get",
      "work.milestones.details.patch",
      "work.milestones.submit.post",
      "work.milestones.request-revision.post",
      "work.milestones.approve.post",
      "institution.milestone-template.get",
      "institution.milestone-template.put",
      "work.milestone-plan.get",
      "work.milestone-plan.add.post",
      "work.milestone-plan.apply-template.post",
      "teacher.assignment-rubric.get",
      "teacher.assignment-rubric.put",
      "student.assignment-rubric.get",
      "teacher.assignment-code-tests.get",
      "teacher.assignment-code-tests.put",
      "student.assignment-code-tests.get",
      "teacher.questionnaires.get",
      "teacher.questionnaires.post",
      "teacher.questionnaire.get",
      "teacher.questionnaire.patch",
      "teacher.questionnaire-state.post",
      "teacher.work-rubric.get",
      "teacher.work-rubric-mark.put",
      "institution.work-template.get",
      "institution.work-template.put",
      "teacher.assignment-template.put",
      "student.assignment-template.get",
      "student.assignment-format-rules.get",
      "work.return-for-revision.post",
      "work.source-notes.get",
      "work.source-notes.post",
      "work.source-notes.patch",
      "work.source-notes.delete",
      "work.version.get",
      "work.compare.get",
      "institution.acknowledgment.post",
      "submission.submit.post",
      "projection.process-summary.post",
      "student.submission.get",
      "student.assignment-requirements.get",
      "teacher.submission-receipt.get",
      "student.assignment-submissions.get",
      "student.submission-confirmation-code.get",
      "teacher.submission-confirmation-code.get",
      "student.receipt-pdf.get",
      "teacher.receipt-pdf.get",
      "student.notice.get",
      "profile.staff-affiliation.get",
      "public.verification.post",
      "auth.webauthn-challenge.post",
      "auth.webauthn-registration.post",
      "auth.webauthn-assertion.post",
      "teacher.fast-path.post",
      "student.assignments.get",
      "student.access-log.get",
      ...SRV_02,
    ]);
    expect(mounted()).toContain("settings.values.put");
    expect(mounted()).toContain("profile.interface-locale.get");
    expect(mounted()).toContain("profile.interface-locale.post");
    expect(mounted()).toContain("support.problem-report.post");
    expect(CONTRACT_ONLY).not.toContain("support.problem-report.post");
    expect(mounted()).toContain("downloads.manifest.get");
    expect(CONTRACT_ONLY).not.toContain("downloads.manifest.get");
    for (const id of [...INSTITUTION_COURSE_ROUTES, ...TEACHER_READ_ROUTES]) {
      expect(mounted()).toContain(id);
      expect(CONTRACT_ONLY).not.toContain(id);
    }
  });

  it("the course routes commented out, over another database or with no argument are not a mount", () => {
    const call = "createInstitutionCourseRoutesFor(databases.main)";
    for (const entry of [
      `// ...${call},`,
      `/* ...${call}, */`,
      "",
      "...createInstitutionCourseRoutesFor(databases.admin),",
      "...createInstitutionCourseRoutesFor(fakeMain),",
      "...createInstitutionCourseRoutesFor(),",
    ]) {
      expect(entryMounted(entry)).toEqual([]);
    }
    expect(entryMounted(`routes: [\n  ...${call},\n]`)).toEqual([...INSTITUTION_COURSE_ROUTES]);
  });

  it("the problem report commented out, over another database or with no argument is not a mount", () => {
    const call = "createProblemReportRouteFor(databases.main)";
    for (const entry of [
      `// ${call},`,
      `/* ${call}, */`,
      "",
      "createProblemReportRouteFor(databases.admin),",
      "createProblemReportRouteFor(fakeMain),",
      "createProblemReportRouteFor(),",
    ]) {
      expect(entryMounted(entry)).toEqual([]);
    }
    expect(entryMounted(`routes: [\n  ${call},\n]`)).toEqual(["support.problem-report.post"]);
  });

  it("the download manifest commented out or over another configuration is not a mount", () => {
    const call = "createDownloadsManifestRoute()";
    for (const entry of [
      `// ${call},`,
      `/* ${call}, */`,
      "",
      "createDownloadsManifestRoute(() => releases),",
      "createDownloadsManifestRoute(undefined),",
    ]) {
      expect(entryMounted(entry)).toEqual([]);
    }
    expect(entryMounted(`routes: [\n  ${call},\n]`)).toEqual(["downloads.manifest.get"]);
  });

  it("each factory gives the route ids of its row", () => {
    for (const row of ENTRY_MOUNTED) expect(row.routes()).toEqual(row.ids);
  });

  it("a call commented out, removed or given another writer is not a mount", () => {
    const call = "createSettingsValuesPutRoute({ writer: databases.main.settingsWriter })";
    for (const entry of [
      `// ${call},`,
      `/* ${call}, */`,
      "",
      "createSettingsValuesPutRoute({ writer: fakeWriter }),",
      "createSettingsValuesPutRoute(),",
    ]) {
      expect(entryMounted(entry)).toEqual([]);
    }
    expect(entryMounted(`routes: [\n  ${call},\n]`)).toEqual(["settings.values.put"]);
  });

  it("WebAuthn commented out, over another database or another origin is not a mount", () => {
    const call = "createWebAuthnRoutesFor(databases.main, APP_ORIGIN)";
    for (const entry of [
      `// ...${call},`,
      `/* ...${call}, */`,
      "",
      "...createWebAuthnRoutesFor(fakeMain, APP_ORIGIN),",
      "...createWebAuthnRoutesFor(databases.main, null),",
      "...createWebAuthnRoutesFor(databases.main, appOrigin(process.env)),",
    ]) {
      expect(entryMounted(entry)).toEqual([]);
    }
  });

  it("server.ts reads APP_ORIGIN once and gives it to the pipeline and to WebAuthn", () => {
    const text = code(ENTRY_TEXT);
    expect(text.match(/\bappOrigin\(/gu)).toHaveLength(1);
    expect(text).toContain("const APP_ORIGIN = appOrigin(process.env);");
    expect(text).toContain("expectedOrigin: APP_ORIGIN");
    expect(text).toContain("createWebAuthnRoutesFor(databases.main, APP_ORIGIN)");
  });

  it("the interface language commented out or over another database is not a mount", () => {
    const call = "createInterfaceLocaleRoutesFor(databases.main)";
    for (const entry of [
      `// ...${call},`,
      `/* ...${call}, */`,
      "",
      "...createInterfaceLocaleRoutesFor(databases.admin),",
      "...createInterfaceLocaleRoutesFor(fakeMain),",
      "...createInterfaceLocaleRoutesFor(),",
    ]) {
      expect(entryMounted(entry)).toEqual([]);
    }
    expect(entryMounted(`routes: [\n  ...${call},\n]`)).toEqual([
      "profile.interface-locale.get",
      "profile.interface-locale.post",
    ]);
  });
});

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Value } from "@sinclair/typebox/value";
import { createSoftwareAuthenticator } from "@ductura/test-fakes/fido2";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createOpenSession } from "../../server/database/index.ts";
import {
  AREA_NAMES,
  createAcknowledgmentRouteFor,
  createAdminCourseRouteFor,
  createEnrollmentCodeStateRouteFor,
  createTeacherRoleRoutesFor,
  createRosterImportRoutesFor,
  createIsvuSourceRoutesFor,
  createAssignmentCurrentVersionRouteFor,
  createAssignmentGradeRouteFor,
  createAttachmentRoutesFor,
  createAuthRoutes,
  createClientContextRoute,
  createClientErrorRoute,
  createCollaborationCommentsRouteFor,
  createRevisionRequestsRouteFor,
  createRevisionSendRouteFor,
  createSuggestionRoutesFor,
  createConsultationRecordRoutesFor,
  createEventDisputeRoutesFor,
  createConsultationSlotRoutesFor,
  createWorkInterviewRoutesFor,
  createWorkInterviewPdfRouteFor,
  createMentorshipRequestRoutesFor,
  createMentorshipStudentRoutesFor,
  createMentorshipConsultationRoutesFor,
  createStudentWorkRoutesFor,
  createKeyDatesRoutesFor,
  createTeachingTeamRoutesFor,
  createMentorNotesRoutesFor,
  createPracticeJournalRoutesFor,
  createWorkTeamRoutesFor,
  createPeerReviewRoutesFor,
  createQualitativeCodesRoutesFor,
  createThesisRoutesFor,
  createThesisTopicRoutesFor,
  createThesisCommitteeRoutesFor,
  createThesisOverviewRoutesFor,
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
  createDatabases,
  createDownloadsManifestRoute,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createEvidenceReplayRouteFor,
  createSubmissionRouteFor,
  createProcessSummaryRouteFor,
  createProcessSummaryDetailsRouteFor,
  createTeacherFastPathRouteFor,
  createCommentRoutesFor,
  createWorkMessagesRoutesFor,
  createMentorshipFollowRoutesFor,
  createWorkPlanRoutesFor,
  createSelfNoteSealedRoutesFor,
  createNotificationsRoutesFor,
  createDirectEditRoutesFor,
  createImportRoutesFor,
  createWorkVersionsRouteFor,
  createRevisionRestoreRouteFor,
  createWorkExportRouteFor,
  createSheetCsvRouteFor,
  createSheetXlsxRouteFor,
  createWorkExportSlidesRouteFor,
  createPortableRecordRouteFor,
  createSubmissionPackageRoutesFor,
  createTeacherSubmissionsBulkRoutesFor,
  createWorkPdfRouteFor,
  createWorkVersionRouteFor,
  createWorkCompareRouteFor,
  createStudentAssignmentWorkRouteFor,
  createStudentNotesRoutesFor,
  createStudentSubmissionRoutesFor,
  createReceiptPdfRoutesFor,
  createStudentNoticeRouteFor,
  createStudentAssignmentsRouteFor,
  createStudentMentoredAssignmentsRouteFor,
  createStudentAccessLogRouteFor,
  createStudentConversationsRouteFor,
  createStudentWriteRoutesFor,
  createHealthRoute,
  createReadyRoute,
  createStatusRouteFor,
  createInstitutionAssignmentRoutesFor,
  createInstitutionCourseRoutesFor,
  createInstitutionGroupRoutesFor,
  createInterfaceLocaleRoutesFor,
  createInternalInstitutionRoutes,
  createLiveRoutesFor,
  createLayers,
  createMeRouteFor,
  createStaffAffiliationRouteFor,
  createProblemReportRouteFor,
  createProblemReportsRouteFor,
  createSettingsReadRoutes,
  createSettingsValuesPutRoute,
  createSourceLookupRouteFor,
  createPublicVerificationRouteFor,
  createTeacherReadRoutesFor,
  createTeacherSubmissionDetailRouteFor,
  createTeacherDeclarationRouteFor,
  createTeacherDeclarationV2RouteFor,
  createTeacherDeclarationConversationRouteFor,
  createTeacherSubmissionNotesRouteFor,
  createCourseAggregateRouteFor,
  createPilotMetricsRouteFor,
  createAnalysisRoutesFor,
  createProblemReportInboxRoutesFor,
  createAdminActionLogRouteFor,
  createRetentionRouteFor,
  createFacultyRuleRoutesFor,
  createAssistantSettingRouteFor,
  createInstitutionConfigRoutesFor,
  createWorkAccessRouteFor,
  createTeacherRosterRoutesFor,
  createInstitutionReadRoutesFor,
  createDeadlineExtensionRoutesFor,
  createLegalHoldRoutesFor,
  createStudentDataExportRoutesFor,
  createStudentDeadlineHistoryRouteFor,
  createSubmissionWithdrawalRoutesFor,
  createAssignmentCopyRouteFor,
  createMerlinRosterRoutesFor,
  createMerlinPackageRoutesFor,
  createAssistantRoutesFor,
  createStatementRoutesFor,
  createTeacherMentorshipRequestRoutesFor,
  createWebAuthnRoutesFor,
  createSourceProofRoutesFor,
  createWorkSourceRoutesFor,
  createSourceNotebookRoutesFor,
  createTextCheckConfigRoute,
  createTeacherWorkRoutesFor,
  createOriginCompositionRoutesFor,
  createAssistantMatchRoutesFor,
  createInputRhythmRoutesFor,
  createDeclarationRequiredRoutesFor,
  createDeclarationQuestionRoutesFor,
  createLateSubmissionRoutesFor,
  createCourseAssistantRoutesFor,
  createQuestionnaireResponsesRoutesFor,
  createQuestionnaireExportRoutesFor,
  createQualitativeMaterialsRoutesFor,
  createQualitativeSegmentsRoutesFor,
  createFacultyThresholdRoutesFor,
  createTeacherSourceRoutesFor,
  createTeacherWorkingCriteriaRoutesFor,
  createWorkRevisionDueRoutesFor,
  evidenceIngestDependencies,
  INTERNAL_PATH_PREFIX,
  type Running,
  routesOf,
  startServer,
  createWorkAccommodationRoutesFor,
} from "../../server/http/index.ts";
import { issuePackageLink } from "../../server/downloads/index.ts";
import { newSessionToken } from "../../server/session/index.ts";

// S-1D-d, DAN-829-2: after POST /api/v1/auth/logout the old session cookie is
// 401 on every mounted route whose contract has a 401, over real HTTP, the real
// pipeline and router, and the real closeSession of the main database (the
// routes are built as server/server.ts builds them). The two sign-outs have no
// 401 (they are idempotent): there the old cookie closes nothing. Every person,
// token and password is random and synthetic; the auth login lives only here.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const AUTH_LOGIN = "it_logout_old_cookie_auth";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const ENV = {
  NODE_ENV: "test",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: "http://127.0.0.1:9",
  OIDC_CLIENT_ID: "ductus-local",
  OIDC_CLIENT_SECRET: "ductus-local-only",
  OIDC_REDIRECT_URI: `${ORIGIN}/api/v1/auth/callback`,
};
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const institution = randomUUID();
const homeOrg = `it-loc-${suffix}.ductus.test`;
const issuer = `https://issuer-loc-${suffix}.test`;

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
const databases = createDatabases();
let auth: pg.Pool;
let server: Running;

// The answer of each route that needs a session to a complete, valid request
// with a live session, so 426, 415 and 422 can never hide the outcome. Both
// 404s are reached only with a live actor (the functions check it first).
// `method` is POST unless given; `old` is the 401 body each contract gives.
const EVIDENCE_401 = { status: "unauthenticated" };
/** A valid document whose JSON.stringify is its JCS form (the vector of a first write). */
const LIVE_DOCUMENT: unknown = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../server/contracts/vectors/live.document.put.json"),
      "utf8",
    ),
  ) as { vectors: { name: string; request: { body: unknown } }[] }
).vectors.find((v) => v.name === "first-write")!.request.body;
/** A course that does not exist: a non-teacher is refused as for any course (C-23). */
const COURSE = randomUUID();
/** A student and an assignment that do not exist either (C-23). */
const STUDENT = randomUUID();
const ASSIGNMENT = randomUUID();
const WORK_SOURCE = {
  id: "00000000-0000-4000-8000-00000000c0a1",
  type: "book",
  authors: [{ kind: "person", family: "Izmišljeni", given: "Autor" }],
  year: 2019,
  title: "Izmišljena knjiga o kućnom kompostiranju",
  place: "Izmišljeni grad",
  publisher: "Izmišljena naklada",
};
const SOURCE_NOTES = `/api/v1/works/doc-izmisljeni-rad/sources/${WORK_SOURCE.id}/notes`;
const SOURCE_NOTE_ID = "00000000-0000-4000-8000-00000000b001";

const IMPORT_ID = randomUUID();
/** A submission that does not exist; the package link is signed for it (SRV-1807). */
const PACKAGE_SUBMISSION = randomUUID();
function rubricCriterion() {
  const level = { label: "Dobro", descriptor: "Izmišljeni opis." };
  return { id: "tema", title: "Izmišljena tema", levels: [level, level, level] };
}

const SESSION_ROUTES = {
  // F4-PM2-R08-SRV: a live session that is no student or holder of the work gets 404.
  "teacher.student-accommodation.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/students/${randomUUID()}/accommodation`,
    body: () => undefined,
    live: 404,
  },
  // F4-PM2-R08-SRV: a live session marking a work that is not its own gets 403.
  "student.accommodation.put": {
    method: "PUT",
    path: `/api/v1/student/assignments/${randomUUID()}/accommodation`,
    body: () => ({ marked: true }),
    live: 403,
  },
  // F4-PM2-R08-SRV: a live session that is no student or holder of the work gets 404.
  "student.accommodation.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/accommodation`,
    body: () => undefined,
    live: 404,
  },
  "evidence.open.post": {
    path: "/api/v1/evidence/open",
    body: () => ({ assignmentId: randomUUID() }),
    live: 404,
  },
  "evidence.commit.post": { path: "/api/v1/evidence/commit", body: () => ({}), live: 422 },
  "evidence.replay.post": {
    path: "/api/v1/evidence/replay",
    body: () => ({ documentId: randomUUID(), from: 0 }),
    live: 404,
  },
  "collaboration.comments.post": {
    path: "/api/v1/comments/list",
    body: () => ({ documentId: randomUUID() }),
    live: 403,
  },
  "collaboration.revision-requests.post": {
    path: "/api/v1/revision-requests/list",
    body: () => ({ documentId: randomUUID() }),
    live: 403,
  },
  // SRV-ED43-DORADA-POSALJI: a work that is not the caller's is 404.
  "collaboration.revision-send.post": {
    path: "/api/v1/revision-send",
    body: () => ({ documentId: randomUUID(), message: null }),
    live: 404,
  },
  // SRV-ED42-PRIJEDLOZI: a work or suggestion that is not the caller's is 404.
  "collaboration.suggestions-list.post": {
    path: "/api/v1/suggestions/list",
    body: () => ({ documentId: randomUUID() }),
    live: 404,
  },
  "collaboration.suggestions.post": {
    path: "/api/v1/suggestions",
    body: () => ({
      anchor: {
        nodeId: "0f0e0d0c-0b0a-4000-8000-000000000001",
        quote: "izmišljeni",
        prefix: "",
        suffix: "",
        startHint: 0,
        endHint: 10,
      },
      documentId: randomUUID(),
      text: "drugi",
    }),
    live: 404,
  },
  "collaboration.suggestion-accept.post": {
    path: "/api/v1/suggestions/accept",
    body: () => ({ suggestionId: randomUUID() }),
    live: 404,
  },
  "collaboration.suggestion-reject.post": {
    path: "/api/v1/suggestions/reject",
    body: () => ({ suggestionId: randomUUID() }),
    live: 404,
  },
  // SRV-1105: a work it may not read is 404 for the list and for both writes.
  "work.consultation-records.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/consultation-records`,
    body: () => undefined,
    live: 404,
  },
  "work.consultation-records.post": {
    path: `/api/v1/works/${randomUUID()}/consultation-records`,
    body: () => ({ heldOn: "2026-11-18", revision: 1, topic: "Tema", agreement: "" }),
    live: 404,
  },
  "work.consultation-additions.post": {
    path: `/api/v1/works/${randomUUID()}/consultation-records/${randomUUID()}/additions`,
    body: () => ({ text: "Dopuna." }),
    live: 404,
  },
  // SRV-1315: a work it may not read is 404 for the list and for the write.
  "work.event-disputes.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/event-disputes`,
    body: () => undefined,
    live: 404,
  },
  "work.event-disputes.post": {
    path: `/api/v1/works/${randomUUID()}/event-disputes`,
    body: () => ({ kind: "dispute", eventId: "pastes/0", text: "Opis." }),
    live: 404,
  },
  // SRV-1106: a work it may not read is 404 for the conversation and for a message.
  "work.messages.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/messages`,
    body: () => undefined,
    live: 404,
  },
  "work.messages.post": {
    path: `/api/v1/works/${randomUUID()}/messages`,
    body: () => ({ text: "Izmišljena poruka." }),
    live: 404,
  },
  // SRV-MENTOR-3: a work that is not the caller's is 404 for the note, the reading place and the marks; the overview of nobody is empty.
  "work.self-note.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/self-note`,
    body: () => undefined,
    live: 404,
  },
  "work.self-note.put": {
    method: "PUT",
    path: `/api/v1/works/${randomUUID()}/self-note`,
    body: () => ({ text: "Izmišljena bilješka." }),
    live: 404,
  },
  "work.self-note.delete": {
    method: "DELETE",
    path: `/api/v1/works/${randomUUID()}/self-note`,
    body: () => undefined,
    live: 404,
  },
  // SRV-F4-PM2-R15: a work that is not the caller's is 404 for the plan.
  "work.plan.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/plan`,
    body: () => undefined,
    live: 404,
  },
  "work.plan.put": {
    method: "PUT",
    path: `/api/v1/works/${randomUUID()}/plan`,
    body: () => ({
      question: null,
      purposes: [],
      terms: [{ term: "Pojam", definition: "Izmišljena definicija.", kind: "term" }],
    }),
    live: 404,
  },
  // SRV-NF6-SIFRA: a work that is not the caller's is 404 for the sealed note; the caller's own key answers.
  "work.sealed-self-note.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/sealed-self-note`,
    body: () => undefined,
    live: 404,
  },
  "work.sealed-self-note.put": {
    method: "PUT",
    path: `/api/v1/works/${randomUUID()}/sealed-self-note`,
    body: () => ({
      sealed: {
        v: 1,
        keyId: randomUUID(),
        iv: Buffer.alloc(12, 1).toString("base64url"),
        ct: Buffer.alloc(1296, 2).toString("base64url"),
      },
    }),
    live: 404,
  },
  "work.sealed-self-note.delete": {
    method: "DELETE",
    path: `/api/v1/works/${randomUUID()}/sealed-self-note`,
    body: () => undefined,
    live: 404,
  },
  "profile.self-note-key.get": {
    method: "GET",
    path: "/api/v1/me/self-note-key",
    body: () => undefined,
    live: 200,
  },
  "profile.self-note-key.put": {
    method: "PUT",
    path: "/api/v1/me/self-note-key",
    body: () => ({
      v: 1,
      keyId: randomUUID(),
      kdf: { alg: "PBKDF2-SHA-256", iterations: 600000 },
      phrase: {
        salt: Buffer.alloc(16, 1).toString("base64url"),
        iv: Buffer.alloc(12, 2).toString("base64url"),
        ct: Buffer.alloc(48, 3).toString("base64url"),
      },
      recovery: {
        salt: Buffer.alloc(16, 4).toString("base64url"),
        iv: Buffer.alloc(12, 5).toString("base64url"),
        ct: Buffer.alloc(48, 6).toString("base64url"),
      },
      ifVersion: null,
    }),
    live: 200,
  },
  "profile.self-note-key.delete": {
    method: "DELETE",
    path: "/api/v1/me/self-note-key",
    body: () => undefined,
    live: 200,
  },
  // SRV-NF6-SIFRA-2: a key the caller does not keep is 409 and deletes nothing.
  "profile.self-note-key-checked.delete": {
    method: "DELETE",
    path: `/api/v1/me/self-note-key/${randomUUID()}?ifVersion=1`,
    body: () => undefined,
    live: 409,
  },
  "work.reading-place.put": {
    method: "PUT",
    path: `/api/v1/works/${randomUUID()}/reading-place`,
    body: () => ({ place: { nodeId: "1f0e2d3c-4b5a-4968-8776-655443322110", offset: 1 } }),
    live: 404,
  },
  "work.reading-place.delete": {
    method: "DELETE",
    path: `/api/v1/works/${randomUUID()}/reading-place`,
    body: () => undefined,
    live: 404,
  },
  "work.seen.post": {
    path: `/api/v1/works/${randomUUID()}/seen`,
    body: () => ({ items: [{ kind: "message", id: randomUUID() }] }),
    live: 404,
  },
  "work.seen-by-student.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/seen-by-student`,
    body: () => undefined,
    live: 404,
  },
  "mentorship.overview.get": {
    method: "GET",
    path: "/api/v1/teacher/mentorship-overview",
    body: () => undefined,
    live: 200,
  },
  "notifications.list.get": {
    method: "GET",
    path: "/api/v1/notifications",
    body: () => undefined,
    live: 200,
  },
  "notifications.returned-for-revision.list.get": {
    method: "GET",
    path: "/api/v1/notifications/returned-for-revision",
    body: () => undefined,
    live: 200,
  },
  "notifications.read.post": {
    path: `/api/v1/notifications/${randomUUID()}/read`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1703: a work it may not teach, a draft or an entry that is not its own, and a student asking for a bank are all 404.
  "work.comment-drafts.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/comment-drafts`,
    body: () => undefined,
    live: 404,
  },
  "work.comment-drafts.post": {
    path: `/api/v1/works/${randomUUID()}/comment-drafts`,
    body: () => ({
      text: "Izmišljena napomena.",
      anchor: {
        nodeId: randomUUID(),
        quote: "odlomak",
        prefix: "",
        suffix: "",
        startHint: 0,
        endHint: 7,
      },
    }),
    live: 404,
  },
  "work.comment-drafts-second.post": {
    path: `/api/v1/works/${randomUUID()}/comment-drafts/v2`,
    body: () => ({ text: "Izmišljen opći komentar.", anchor: null, kind: "q" }),
    live: 404,
  },
  "work.comment-draft.delete": {
    method: "DELETE",
    path: `/api/v1/comment-drafts/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "work.comments.publish.post": {
    path: `/api/v1/works/${randomUUID()}/comments/publish`,
    body: () => undefined,
    live: 404,
  },
  "work.comments.publish-selected.post": {
    path: `/api/v1/works/${randomUUID()}/comments/publish-selected`,
    body: () => ({ draftIds: [randomUUID()] }),
    live: 404,
  },
  "teacher.comment-bank.get": {
    method: "GET",
    path: "/api/v1/teacher/comment-bank",
    body: () => undefined,
    live: 200,
  },
  "teacher.comment-bank.post": {
    path: "/api/v1/teacher/comment-bank",
    body: () => ({ text: "Izmišljeno: navedite izvor.", kind: "must" }),
    live: 404,
  },
  "teacher.comment-bank-entry.put": {
    method: "PUT",
    path: `/api/v1/teacher/comment-bank/${randomUUID()}`,
    body: () => ({ text: "Izmišljeno: dopunite izvor.", kind: "sugg", label: "Izvor" }),
    live: 404,
  },
  "teacher.comment-bank.delete": {
    method: "DELETE",
    path: `/api/v1/teacher/comment-bank/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "work.review.post": {
    path: `/api/v1/works/${randomUUID()}/review`,
    body: () => undefined,
    live: 404,
  },
  "work.changes-since-review.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/changes-since-review`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1702: a work it may not read is 404 for the setting and for setting it.
  "work.direct-edit.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/direct-edit`,
    body: () => undefined,
    live: 404,
  },
  "work.direct-edit.put": {
    method: "PUT",
    path: `/api/v1/works/${randomUUID()}/direct-edit`,
    body: () => ({ mode: "direct" }),
    live: 404,
  },
  // SRV-1803: a work it may not import into is 404; an import of it is not found.
  "work.imports.post": {
    path: `/api/v1/works/${randomUUID()}/imports`,
    body: () => ({ fileBase64: "UEsDBA==", fileName: null }),
    live: 404,
  },
  "work.imports.confirm.post": {
    path: `/api/v1/works/${randomUUID()}/imports/${IMPORT_ID}/confirm`,
    body: () => ({ importId: IMPORT_ID, manifestSha256: "0".repeat(64) }),
    live: 404,
  },
  // SRV-18: a live session naming a work it does not own gets 404 and submits nothing.
  "submission.submit.post": {
    path: "/api/v1/submission",
    body: () => ({ documentId: randomUUID(), revision: 1 }),
    live: 404,
  },
  // PIL-K-IZJAVA-SRV: the second major, the same 404 for a work the session does not own.
  "submission.submit-second.post": {
    path: "/api/v1/submission/v2",
    body: () => ({ documentId: randomUUID(), revision: 1 }),
    live: 404,
  },
  // SRV-23: a live session naming a work it may not read gets 404 and logs nothing.
  "projection.process-summary.post": {
    path: "/api/v1/process-summary",
    body: () => ({ documentId: randomUUID() }),
    live: 404,
  },
  // SRV-9D: the details of a work it may not read are 404 too.
  "projection.process-summary-details.post": {
    path: "/api/v1/process-summary/details",
    body: () => ({ documentId: randomUUID() }),
    live: 404,
  },
  // SRV-8E: an assignment the caller does not teach is the same empty list.
  "teacher.fast-path.post": {
    path: "/api/v1/teacher/fast-path",
    body: () => ({ assignmentId: randomUUID() }),
    live: 200,
  },
  // SRV-9A: the versions of a work it may not read are 404, as a missing work.
  "work.versions.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/versions`,
    body: () => undefined,
    live: 404,
  },
  // INT-21 C: a restore on a work it does not own is 404, as a missing work.
  "work.restore.post": {
    method: "POST",
    path: `/api/v1/works/${randomUUID()}/restores`,
    body: () => ({ fromRevision: 1 }),
    live: 404,
  },
  // SRV-1310: the export of a work it may not read is 404, as a missing work.
  "work.export.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/export?format=docx`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V14-SHEET-CSV: the CSV of a work it may not read is 404, as a missing work.
  "work.export-sheet-csv.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/export/csv`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V14-SHEET-XLSX: the .xlsx of a work it may not read is 404, as a missing work.
  "work.export-sheet-xlsx.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/export/xlsx`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V13-RUTA-IZVOZ: the slides export of a work it may not read is 404, as a missing work.
  "work.export-slides.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/export-slides?format=pptx`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1312: the portable record of a submission that is not the caller's is 404, as a missing one.
  "student.portable-record.get": {
    method: "GET",
    path: `/api/v1/student/submissions/${randomUUID()}/portable-record`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1807: a link that is not this session's, or a submission that is not the caller's, is 404.
  "student.submission-package-link.post": {
    method: "POST",
    path: `/api/v1/student/submissions/${randomUUID()}/package-link`,
    body: () => ({ kind: "package" }),
    live: 404,
  },
  // The link is this session's own (issued with its token), so the download
  // reaches the session check: a live session reads no such submission (404),
  // and the same link with the cookie after logout is 401, not the 404 of a
  // foreign link.
  "student.submission-package.get": {
    method: "GET",
    path: `/api/v1/student/submissions/${PACKAGE_SUBMISSION}/package/package`,
    pathFor: (token: string) =>
      `/api/v1/student/submissions/${PACKAGE_SUBMISSION}/package/package?token=${
        issuePackageLink(token, PACKAGE_SUBMISSION, "package", Date.now()).token
      }`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1902: a link that is not this session's, or an assignment the caller does not teach, is 404.
  "teacher.submissions-bulk-link.post": {
    method: "POST",
    path: `/api/v1/teacher/assignments/${randomUUID()}/submissions-bulk-link`,
    body: () => ({ format: "pdf" }),
    live: 404,
  },
  "teacher.submissions-bulk.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/submissions-bulk/pdf?token=1763800000000.${"A".repeat(43)}`,
    body: () => undefined,
    live: 404,
  },
  "work.export-pdf.get": {
    method: "GET",
    path: `/api/v1/assignments/${randomUUID()}/works/${randomUUID()}/export/pdf`,
    body: () => undefined,
    live: 404,
  },
  "work.version.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/versions/1`,
    body: () => undefined,
    live: 404,
  },
  "work.compare.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/compare?from=1&to=2`,
    body: () => undefined,
    live: 404,
  },
  "work.consultation-slots.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/consultation-slots`,
    body: () => undefined,
    live: 403,
  },
  "work.consultation-slots.post": {
    path: `/api/v1/works/${randomUUID()}/consultation-slots`,
    body: () => ({ startsAt: new Date(Date.now() + 86_400_000).toISOString() }),
    live: 403,
  },
  "work.consultation-slots.patch": {
    method: "PATCH",
    path: `/api/v1/works/${randomUUID()}/consultation-slots/${randomUUID()}`,
    body: () => ({ action: "confirm" }),
    live: 403,
  },
  // SRV-MENTOR-1: a work the live account has no relation to; slots 403, tasks 404.
  "work.consultation-slot-details.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/consultation-slot-details`,
    body: () => undefined,
    live: 403,
  },
  "work.consultation-slot-requests.post": {
    path: `/api/v1/works/${randomUUID()}/consultation-slot-requests`,
    body: () => ({ startsAt: new Date(Date.now() + 86_400_000).toISOString() }),
    live: 403,
  },
  "work.consultation-slot-close.post": {
    path: `/api/v1/works/${randomUUID()}/consultation-slots/${randomUUID()}/close`,
    body: () => ({ action: "withdraw" }),
    live: 403,
  },
  "work.consultation-tasks.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/consultation-tasks`,
    body: () => undefined,
    live: 404,
  },
  "work.consultation-tasks.post": {
    path: `/api/v1/works/${randomUUID()}/consultation-records/${randomUUID()}/tasks`,
    body: () => ({ text: "Izmišljeni zadatak." }),
    live: 404,
  },
  "work.consultation-task-mark.post": {
    path: `/api/v1/works/${randomUUID()}/consultation-tasks/${randomUUID()}/mark`,
    body: () => ({ done: true }),
    live: 404,
  },
  // SRV-MENTOR-1: the live account is no teacher, so opening reads 404; its own lists are empty.
  "mentorship.open.post": {
    path: "/api/v1/mentorships",
    body: () => ({ studentId: randomUUID(), workType: "master_thesis" }),
    live: 404,
  },
  "mentorship.student-mentorships.get": {
    method: "GET",
    path: "/api/v1/student/mentorships",
    body: () => undefined,
    live: 200,
  },
  "notifications.mentorship-opened.list.get": {
    method: "GET",
    path: "/api/v1/notifications/mentorship-opened",
    body: () => undefined,
    live: 200,
  },
  "work.interview.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/interview`,
    body: () => undefined,
    live: 403,
  },
  "work.interview-pdf.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/interview/pdf`,
    body: () => undefined,
    live: 403,
  },
  "work.interview-questions.post": {
    path: `/api/v1/works/${randomUUID()}/interview/questions`,
    body: () => ({ questionText: "Kako je nastao ovaj odlomak?" }),
    live: 403,
  },
  "work.interview-questions.delete": {
    method: "DELETE",
    path: `/api/v1/works/${randomUUID()}/interview/questions/${randomUUID()}`,
    body: () => undefined,
    live: 403,
  },
  "work.interview-invite.post": {
    path: `/api/v1/works/${randomUUID()}/interview/invite`,
    body: () => undefined,
    live: 403,
  },
  "work.interview-appointment.put": {
    method: "PUT",
    path: `/api/v1/works/${randomUUID()}/interview/appointment`,
    body: () => ({ consultationSlotId: randomUUID() }),
    live: 403,
  },
  "work.interview-held.post": {
    path: `/api/v1/works/${randomUUID()}/interview/held`,
    body: () => ({ date: "2026-11-01" }),
    live: 403,
  },
  "work.interview-explanations.post": {
    path: `/api/v1/works/${randomUUID()}/interview/explanations`,
    body: () => ({ text: "Objašnjenje." }),
    live: 403,
  },
  "work.interview-notes.post": {
    path: `/api/v1/works/${randomUUID()}/interview/notes`,
    body: () => ({
      fileName: "biljeska.txt",
      mediaType: "text/plain",
      contentBase64: Buffer.from("Bilješka.").toString("base64"),
    }),
    live: 403,
  },
  "mentorship.key-dates.get": {
    method: "GET",
    path: `/api/v1/mentorships/${randomUUID()}/key-dates`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1414: the student's own requests and candidates; the live account holds no teacher role.
  "mentorship.student-requests.get": {
    method: "GET",
    path: "/api/v1/student/mentorship-requests",
    body: () => undefined,
    live: 200,
  },
  "mentorship.student-mentor-candidates.get": {
    method: "GET",
    path: "/api/v1/student/mentor-candidates",
    body: () => undefined,
    live: 200,
  },
  // SRV-1412: an assignment of no course of the account is 404; its own works are none.
  "student-work.start.post": {
    path: `/api/v1/assignments/${randomUUID()}/start`,
    body: () => undefined,
    live: 404,
  },
  "student-work.works.get": {
    method: "GET",
    path: "/api/v1/student/works",
    body: () => undefined,
    live: 200,
  },
  // SRV-1407: a request, or a teacher, the account has no relation to is 404.
  "mentorship.requests.post": {
    path: "/api/v1/mentorship-requests",
    body: () => ({ teacherId: randomUUID(), workType: "master_thesis" }),
    live: 404,
  },
  "mentorship.request-approve.post": {
    path: `/api/v1/mentorship-requests/${randomUUID()}/approve`,
    body: () => undefined,
    live: 404,
  },
  "mentorship.request-decline.post": {
    path: `/api/v1/mentorship-requests/${randomUUID()}/decline`,
    body: () => ({}),
    live: 404,
  },
  "mentorship.request-withdraw.post": {
    path: `/api/v1/mentorship-requests/${randomUUID()}/withdraw`,
    body: () => undefined,
    live: 404,
  },
  "institution.teaching-team.get": {
    method: "GET",
    path: `/api/v1/courses/${randomUUID()}/team`,
    body: () => undefined,
    live: 403,
  },
  "institution.teaching-team-view.get": {
    method: "GET",
    path: `/api/v1/courses/${randomUUID()}/team/view`,
    body: () => undefined,
    live: 403,
  },
  "institution.teaching-team-candidates.get": {
    method: "GET",
    path: `/api/v1/courses/${randomUUID()}/team/candidates`,
    body: () => undefined,
    live: 403,
  },
  "institution.teaching-team.post": {
    path: `/api/v1/courses/${randomUUID()}/team`,
    body: () => ({ assistantIds: [] }),
    live: 403,
  },
  "institution.teaching-group-members.put": {
    method: "PUT",
    path: `/api/v1/courses/${randomUUID()}/groups/${randomUUID()}/members`,
    body: () => ({ assistantIds: [], studentIds: [] }),
    live: 403,
  },
  "mentorship.notes.get": {
    method: "GET",
    path: `/api/v1/mentorships/${randomUUID()}/notes`,
    body: () => undefined,
    live: 404,
  },
  "mentorship.notes.post": {
    path: `/api/v1/mentorships/${randomUUID()}/notes`,
    body: () => ({ body: "Izmisljena biljeska." }),
    live: 404,
  },
  // SRV-V19-DNEVNIK-RUTE: a live session with no part in any practice reads 404 (or an empty list).
  "practice.placements.post": {
    path: "/api/v1/practice/placements",
    body: () => ({
      mentorshipId: randomUUID(),
      organisationName: "Izmisljena organizacija",
      startsOn: "2026-10-01",
      endsOn: "2026-12-01",
    }),
    live: 404,
  },
  "practice.placements.get": {
    method: "GET",
    path: "/api/v1/practice/placements",
    body: () => undefined,
    live: 200,
  },
  "practice.entries.get": {
    method: "GET",
    path: `/api/v1/practice/placements/${randomUUID()}/entries`,
    body: () => undefined,
    live: 404,
  },
  "practice.entries.post": {
    path: `/api/v1/practice/placements/${randomUUID()}/entries`,
    body: () => ({ date: "2026-11-02", hours: 4, text: "Izmisljeni zapis." }),
    live: 404,
  },
  "practice.signoffs.post": {
    path: `/api/v1/practice/placements/${randomUUID()}/signoffs`,
    body: () => ({ throughDate: "2026-11-02" }),
    live: 404,
  },
  "practice.signoffs.get": {
    method: "GET",
    path: `/api/v1/practice/placements/${randomUUID()}/signoffs`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V19-GRUPA-RUTE: a live session with no part in any assignment of teams reads 404.
  "institution.assignment-team-setting.put": {
    method: "PUT",
    path: `/api/v1/institution/assignments/${randomUUID()}/team-setting`,
    body: () => ({ enabled: true, minSize: 2, maxSize: 4, formation: "student_choice" }),
    live: 404,
  },
  "institution.assignment-team-setting.get": {
    method: "GET",
    path: `/api/v1/institution/assignments/${randomUUID()}/team-setting`,
    body: () => undefined,
    live: 404,
  },
  "student.work-team.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/team`,
    body: () => undefined,
    live: 404,
  },
  "student.work-team.post": {
    path: `/api/v1/student/assignments/${randomUUID()}/team`,
    body: () => ({ action: "create" }),
    live: 404,
  },
  "teacher.work-teams.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/teams`,
    body: () => undefined,
    live: 404,
  },
  "teacher.work-teams.post": {
    path: `/api/v1/teacher/assignments/${randomUUID()}/teams`,
    body: () => undefined,
    live: 404,
  },
  "teacher.work-team-member.post": {
    path: `/api/v1/teacher/assignments/${randomUUID()}/teams/${randomUUID()}/members`,
    body: () => ({ studentId: randomUUID(), action: "add" }),
    live: 404,
  },
  "student.work-team-contribution.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/team/contribution`,
    body: () => undefined,
    live: 404,
  },
  "teacher.work-team-contribution.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/teams/${randomUUID()}/contribution`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V19-RECENZIJA-RUTE: a live session with no part in any peer review reads 404.
  "peer-review.round.put": {
    method: "PUT",
    path: `/api/v1/teacher/assignments/${randomUUID()}/peer-review`,
    body: () => ({
      opensAt: "2026-12-01T08:00:00.000Z",
      dueAt: "2026-12-08T08:00:00.000Z",
      reviewsPerStudent: 2,
      rubrics: [{ key: "clarity", label: "Clarity" }],
    }),
    live: 404,
  },
  "peer-review.round.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/peer-review`,
    body: () => undefined,
    live: 404,
  },
  "peer-review.allocate.post": {
    method: "POST",
    path: `/api/v1/teacher/assignments/${randomUUID()}/peer-review/allocations`,
    body: () => undefined,
    live: 404,
  },
  "peer-review.teacher-overview.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/peer-review/overview`,
    body: () => undefined,
    live: 404,
  },
  "peer-review.review-withdrawal.post": {
    method: "POST",
    path: `/api/v1/teacher/assignments/${randomUUID()}/peer-review/reviews/${randomUUID()}/withdrawal`,
    body: () => ({ reason: "Invented reason." }),
    live: 404,
  },
  "student.peer-review-tasks.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/peer-review/tasks`,
    body: () => undefined,
    live: 404,
  },
  "student.peer-review-work.get": {
    method: "GET",
    path: `/api/v1/student/peer-review/tasks/${randomUUID()}/work`,
    body: () => undefined,
    live: 404,
  },
  "student.peer-review.post": {
    method: "POST",
    path: `/api/v1/student/peer-review/tasks/${randomUUID()}/review`,
    body: () => ({ byRubric: [{ key: "clarity", text: "Invented text." }] }),
    live: 404,
  },
  "student.peer-reviews-received.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/peer-review/received`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V18-KODIRANJE-SIFRARNIK: a live session with no code of that id reads 404; the codebook itself is the caller's own.
  "student.qual-codes.get": {
    method: "GET",
    path: "/api/v1/student/qual/codes",
    body: () => undefined,
    live: 200,
  },
  "student.qual-codes.post": {
    method: "POST",
    path: "/api/v1/student/qual/codes",
    body: () => ({ name: "Izmišljeni kod nakon odjave" }),
    live: 201,
  },
  "student.qual-code.patch": {
    method: "PATCH",
    path: `/api/v1/student/qual/codes/${randomUUID()}`,
    body: () => ({ name: "Izmišljeni novi naziv" }),
    live: 404,
  },
  "student.qual-code.delete": {
    method: "DELETE",
    path: `/api/v1/student/qual/codes/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  // SRV-MENTOR-2: a live session with no part in any thesis.
  "institution.thesis-forms.get": {
    method: "GET",
    path: "/api/v1/institution/thesis-forms",
    body: () => undefined,
    live: 200,
  },
  "institution.thesis-forms.post": {
    path: "/api/v1/institution/thesis-forms",
    body: () => ({
      code: "prijava-teme",
      title: "Izmišljena prijava teme",
      workTypes: ["master_thesis"],
      active: true,
    }),
    live: 403,
  },
  "institution.thesis-settings.get": {
    method: "GET",
    path: "/api/v1/institution/thesis-settings",
    body: () => undefined,
    live: 403,
  },
  "institution.thesis-settings.put": {
    method: "PUT",
    path: "/api/v1/institution/thesis-settings",
    body: () => ({ mentorConsentRequired: true }),
    live: 403,
  },
  "work.thesis-forms.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-forms",
    body: () => undefined,
    live: 404,
  },
  "work.thesis-form.put": {
    method: "PUT",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-forms/prijava-teme",
    body: () => ({ state: "submitted" }),
    live: 404,
  },
  "work.mentor-consent.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/mentor-consent",
    body: () => undefined,
    live: 404,
  },
  "work.mentor-consent.put": {
    method: "PUT",
    path: "/api/v1/works/izmisljeni-rad-0001/mentor-consent",
    body: () => ({ given: true }),
    live: 404,
  },
  "work.thesis-stage.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-stage",
    body: () => undefined,
    live: 404,
  },
  "work.thesis-stage.put": {
    method: "PUT",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-stage",
    body: () => ({ stage: "submitted_to_office" }),
    live: 404,
  },
  // SRV-V16-TEMA-PRIJEDLOG: a live session with no part in any thesis reads 404 on all three.
  "work.thesis-topic.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-topic",
    body: () => undefined,
    live: 404,
  },
  "work.thesis-topic.put": {
    method: "PUT",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-topic",
    body: () => ({ title: "Izmišljena tema rada" }),
    live: 404,
  },
  "work.thesis-topic-decision.post": {
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-topic/decision",
    body: () => ({ version: 1, decision: "approved" }),
    live: 404,
  },
  // SRV-V16-POVJERENSTVO-ZAPIS: a live session with no part in any thesis reads 404 on both.
  "work.thesis-committee.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-committee",
    body: () => undefined,
    live: 404,
  },
  "work.thesis-committee.put": {
    method: "PUT",
    path: "/api/v1/works/izmisljeni-rad-0001/thesis-committee",
    body: () => ({ members: [] }),
    live: 404,
  },
  // SRV-V16-POPIS-FAKULTET: a live session of an account that is no administrator reads 403.
  "institution.thesis-overview.get": {
    method: "GET",
    path: "/api/v1/institution/thesis-overview",
    body: () => undefined,
    live: 403,
  },
  "student.assignment-work.get": {
    method: "GET",
    path: "/api/v1/student/assignment-work",
    body: () => undefined,
    live: 200,
  },
  "student.submission-notes.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/submission-notes`,
    body: () => undefined,
    live: 404,
  },
  "student.submission-notes.post": {
    path: "/api/v1/student/submission-notes",
    body: () => ({ assignmentId: ASSIGNMENT, text: "Izmišljena napomena o radu." }),
    live: 404,
  },
  // Faza 3: the student's assignment list, own access log of a work that is not
  // theirs (404), enrolment by code (503: this institution is inserted without
  // provisioning, so it has no institution_settings row and the RPC raises ZD503)
  // and the notice of an assignment the session cannot see (404).
  "student.assignments.get": {
    method: "GET",
    path: "/api/v1/student/assignments",
    body: () => undefined,
    live: 200,
  },
  // INT-31: the assignments of the caller's open mentorships; none here, so an empty list.
  "student.mentored-assignments.get": {
    method: "GET",
    path: "/api/v1/student/mentored-assignments",
    body: () => undefined,
    live: 200,
  },
  "student.access-log.get": {
    method: "GET",
    path: `/api/v1/student/works/${randomUUID()}/access-log`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1706: the same log in days; a work that is not the caller's is 404.
  "work.access.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/access`,
    body: () => undefined,
    live: 404,
  },
  "student.enrollments.post": {
    path: "/api/v1/student/enrollments",
    body: () => ({ code: "IZMISLJENI-KOD-1" }),
    live: 503,
  },
  "student.notice-read.post": {
    path: `/api/v1/student/assignments/${ASSIGNMENT}/notice-read`,
    body: () => ({ versionNo: 1 }),
    live: 404,
  },
  // SRV-1101: the same for the text check configuration.
  // SRV-1102: the proofs of a source; a live session that is no student of the work gets 404.
  // SRV-10C: the attachments of a work; a live session that is no party to the work gets 404.
  "work.attachments.post": {
    method: "POST",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/attachments`,
    body: () => ({
      imageBase64:
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAANSURBVBhXY2BgYGAAAAAFAAGKM+MAAAAAAElFTkSuQmCC",
    }),
    live: 404,
  },
  "work.attachments.get": {
    method: "GET",
    path: `/api/v1/work-attachments/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "work.milestones.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/milestones`,
    body: () => undefined,
    live: 404,
  },
  "work.milestones.patch": {
    method: "PATCH",
    path: `/api/v1/works/${randomUUID()}/milestones/${randomUUID()}`,
    body: () => ({ dueAt: "2026-12-02T12:00:00.000Z" }),
    live: 404,
  },
  "work.milestone-states.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/milestone-states`,
    body: () => undefined,
    live: 404,
  },
  "work.milestones.details.patch": {
    method: "PATCH",
    path: `/api/v1/works/${randomUUID()}/milestones/${randomUUID()}/details`,
    body: () => ({ title: "Nacrt" }),
    live: 404,
  },
  "work.milestones.delete": {
    method: "DELETE",
    path: `/api/v1/works/${randomUUID()}/milestones/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "work.milestones.submit.post": {
    method: "POST",
    path: `/api/v1/works/${randomUUID()}/milestones/${randomUUID()}/submit`,
    body: () => undefined,
    live: 404,
  },
  "work.milestones.request-revision.post": {
    method: "POST",
    path: `/api/v1/works/${randomUUID()}/milestones/${randomUUID()}/request-revision`,
    body: () => ({ comment: "Dopuni uvod." }),
    live: 404,
  },
  "teacher.assignment-rubric.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/rubric`,
    body: () => undefined,
    live: 404,
  },
  "teacher.assignment-rubric.put": {
    method: "PUT",
    path: `/api/v1/teacher/assignments/${randomUUID()}/rubric`,
    body: () => ({ expectedVersion: 0, criteria: [rubricCriterion()] }),
    live: 404,
  },
  "student.assignment-rubric.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/rubric`,
    body: () => undefined,
    live: 404,
  },
  "teacher.assignment-code-tests.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/code-tests`,
    body: () => undefined,
    live: 404,
  },
  "teacher.assignment-code-tests.put": {
    method: "PUT",
    path: `/api/v1/teacher/assignments/${randomUUID()}/code-tests`,
    body: () => ({ language: "javascript", tests: [] }),
    live: 404,
  },
  "student.assignment-code-tests.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/code-tests`,
    body: () => undefined,
    live: 404,
  },
  "teacher.questionnaires.get": {
    method: "GET",
    path: `/api/v1/teacher/courses/${randomUUID()}/questionnaires`,
    body: () => undefined,
    live: 404,
  },
  "teacher.questionnaires.post": {
    method: "POST",
    path: `/api/v1/teacher/courses/${randomUUID()}/questionnaires`,
    body: () => ({
      title: "Izmišljeni upitnik",
      questions: [{ kind: "text", text: "Primjedba?" }],
    }),
    live: 404,
  },
  "teacher.questionnaire.get": {
    method: "GET",
    path: `/api/v1/teacher/questionnaires/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "teacher.questionnaire.patch": {
    method: "PATCH",
    path: `/api/v1/teacher/questionnaires/${randomUUID()}`,
    body: () => ({
      title: "Izmišljeni upitnik",
      questions: [{ kind: "text", text: "Primjedba?" }],
    }),
    live: 404,
  },
  "teacher.questionnaire-state.post": {
    method: "POST",
    path: `/api/v1/teacher/questionnaires/${randomUUID()}/state`,
    body: () => ({ state: "open" }),
    live: 404,
  },
  "institution.milestone-template.get": {
    method: "GET",
    path: "/api/v1/institution/milestone-template",
    body: () => undefined,
    live: 403,
  },
  "institution.milestone-template.put": {
    method: "PUT",
    path: "/api/v1/institution/milestone-template",
    body: () => ({ expectedVersion: 0, requireFinalStageApproval: false, milestones: [] }),
    live: 403,
  },
  "institution.work-template.get": {
    method: "GET",
    path: "/api/v1/institution/work-templates/seminar_paper",
    body: () => undefined,
    live: 403,
  },
  "institution.work-template.put": {
    method: "PUT",
    path: "/api/v1/institution/work-templates/seminar_paper",
    body: () => ({ expectedVersion: 0, titlePage: [], sections: [], citationStyle: "fpzg" }),
    live: 403,
  },
  // SRV-V17-TEMPLATE-ASSIGN: a live session that teaches no such assignment gets 404.
  "teacher.assignment-template.put": {
    method: "PUT",
    path: `/api/v1/teacher/assignments/${randomUUID()}/template`,
    body: () => ({ useInstitutionTemplate: true }),
    live: 404,
  },
  "student.assignment-template.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/template`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V17-FORMAT-RULES: a live session that is no student of the assignment's course gets 404.
  "student.assignment-format-rules.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/format-rules`,
    body: () => undefined,
    live: 404,
  },
  "work.milestone-plan.get": {
    method: "GET",
    path: `/api/v1/works/${randomUUID()}/milestone-plan`,
    body: () => undefined,
    live: 404,
  },
  "work.milestone-plan.add.post": {
    method: "POST",
    path: `/api/v1/works/${randomUUID()}/milestone-plan/milestones`,
    body: () => ({ title: "Nacrt", submits: "topic_text" }),
    live: 404,
  },
  "work.milestone-plan.apply-template.post": {
    method: "POST",
    path: `/api/v1/works/${randomUUID()}/milestone-plan/apply-template`,
    body: () => undefined,
    live: 404,
  },
  "work.milestones.approve.post": {
    method: "POST",
    path: `/api/v1/works/${randomUUID()}/milestones/${randomUUID()}/approve`,
    body: () => ({}),
    live: 404,
  },
  "work.return-for-revision.post": {
    method: "POST",
    path: `/api/v1/works/${randomUUID()}/return-for-revision`,
    body: () => ({ comment: "Doradi uvod." }),
    live: 404,
  },
  "student.source-proofs.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/sources/${WORK_SOURCE.id}/proofs`,
    body: () => undefined,
    live: 404,
  },
  "student.source-proofs.post": {
    path: `/api/v1/student/assignments/${ASSIGNMENT}/sources/${WORK_SOURCE.id}/proofs`,
    body: () => undefined,
    // A valid form, so the answer comes from the database and not from the input check.
    form: () => {
      const form = new FormData();
      form.append("page", "14");
      const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
      form.append("image", new Blob([jpeg], { type: "image/jpeg" }), "isjecak.jpg");
      return form;
    },
    live: 404,
  },
  "student.source-proof-image.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/sources/${WORK_SOURCE.id}/proofs/${WORK_SOURCE.id}/image`,
    body: () => undefined,
    live: 404,
  },
  "student.text-check-config.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/text-check-config`,
    body: () => undefined,
    live: 404,
  },
  // SRV-2003: a live session that teaches no such work gets 404 on the read of the work.
  "teacher.work.get": {
    method: "GET",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001",
    body: () => undefined,
    live: 404,
  },
  // SRV-0910: a live session that has no such work gets 404 on the composition by origin.
  // SRV-1111: the thresholds of a faculty; not an administrator, so 403; the comparison of a work that is not the caller's, so 404.
  "institution.origin-thresholds.get": {
    method: "GET",
    path: "/api/v1/institution/origin-thresholds",
    body: () => undefined,
    live: 403,
  },
  "institution.origin-threshold.put": {
    method: "PUT",
    path: "/api/v1/institution/origin-thresholds/typed",
    body: () => ({ thresholdPercent: 90, strictness: "soft" }),
    live: 403,
  },
  "institution.origin-threshold.delete": {
    method: "DELETE",
    path: "/api/v1/institution/origin-thresholds/typed",
    body: () => undefined,
    live: 403,
  },
  // SRV-1605: the guidance of a teacher on sources; a live session with no relation to the work or course gets 404 on every one.
  "teacher.source-guidance.get": {
    method: "GET",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/source-guidance",
    body: () => undefined,
    live: 404,
  },
  "teacher.source-recommendation.put": {
    method: "PUT",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/source-recommendations/00000000-0000-4000-8000-00000000c5a1",
    body: () => ({
      record: {
        id: "00000000-0000-4000-8000-00000000c5a1",
        type: "book",
        authors: [{ kind: "person", family: "Izmišljeni", given: "Autor" }],
        year: 2019,
        title: "Izmišljena knjiga",
        place: "Izmišljeni grad",
        publisher: "Izmišljena naklada",
      },
      requirement: "recommended",
    }),
    live: 404,
  },
  "teacher.source-recommendation.delete": {
    method: "DELETE",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/source-recommendations/00000000-0000-4000-8000-00000000c5a1",
    body: () => undefined,
    live: 404,
  },
  "teacher.source-proof-request.put": {
    method: "PUT",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/sources/00000000-0000-4000-8000-00000000c5a1/proof-request",
    body: () => ({ instruction: "Priložite stranicu 14.", dueAt: "2099-01-01T10:00:00.000Z" }),
    live: 404,
  },
  "teacher.source-proof-request.delete": {
    method: "DELETE",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/sources/00000000-0000-4000-8000-00000000c5a1/proof-request",
    body: () => undefined,
    live: 404,
  },
  "teacher.literature-seen.put": {
    method: "PUT",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/literature-seen",
    body: () => undefined,
    live: 404,
  },
  "teacher.source-proofs.get": {
    method: "GET",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/sources/00000000-0000-4000-8000-00000000c5a1/proofs",
    body: () => undefined,
    live: 404,
  },
  "teacher.source-proof-image.get": {
    method: "GET",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/sources/00000000-0000-4000-8000-00000000c5a1/proofs/00000000-0000-4000-8000-00000000d5a1/image",
    body: () => undefined,
    live: 404,
  },
  "teacher.course-literature.get": {
    method: "GET",
    path: "/api/v1/teacher/courses/00000000-0000-4000-8000-0000000000c1/required-literature",
    body: () => undefined,
    live: 404,
  },
  "teacher.course-literature.put": {
    method: "PUT",
    path: "/api/v1/teacher/courses/00000000-0000-4000-8000-0000000000c1/required-literature/00000000-0000-4000-8000-00000000c5a1",
    body: () => ({
      record: {
        id: "00000000-0000-4000-8000-00000000c5a1",
        type: "book",
        authors: [{ kind: "person", family: "Izmišljeni", given: "Autor" }],
        year: 2019,
        title: "Izmišljena knjiga",
        place: "Izmišljeni grad",
        publisher: "Izmišljena naklada",
      },
    }),
    live: 404,
  },
  "teacher.course-literature.delete": {
    method: "DELETE",
    path: "/api/v1/teacher/courses/00000000-0000-4000-8000-0000000000c1/required-literature/00000000-0000-4000-8000-00000000c5a1",
    body: () => undefined,
    live: 404,
  },
  "student.course-literature.get": {
    method: "GET",
    path: "/api/v1/student/courses/00000000-0000-4000-8000-0000000000c1/required-literature",
    body: () => undefined,
    live: 404,
  },
  "student.source-proof-requests.get": {
    method: "GET",
    path: "/api/v1/student/assignments/00000000-0000-4000-8000-0000000000a1/source-proof-requests",
    body: () => undefined,
    live: 404,
  },
  "work.origin-thresholds.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/origin-thresholds",
    body: () => undefined,
    live: 404,
  },
  "work.origin-composition.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/origin-composition",
    body: () => undefined,
    live: 404,
  },
  // SRV-KARTA-RASPON: the same for the ranges of origin of a revision.
  "work.origin-segments.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/origin-segments",
    body: () => undefined,
    live: 404,
  },
  // SRV-KARTA-RASPON-RUTA: the same on the owner's write of the ranges.
  "work.origin-segments.post": {
    method: "POST",
    path: "/api/v1/works/izmisljeni-rad-0001/origin-segments",
    body: () => ({
      revision: 1,
      segments: [
        { blockId: "1b0c2d3e-4f50-4a61-8b72-0c1d2e3f4a51", start: 0, end: 9, kind: "typed" },
      ],
    }),
    live: 404,
  },
  // SRV-1230: a live session that has no such work gets 404 on the match with the assistant.
  "work.assistant-match.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/assistant-match",
    body: () => undefined,
    live: 404,
  },
  "work.assistant-match.post": {
    method: "POST",
    path: "/api/v1/works/izmisljeni-rad-0001/assistant-match",
    body: () => ({ segmentRef: "blok-1", text: "izmišljeni tekst odlomka" }),
    live: 404,
  },
  // PIL-P1-PODUDARANJE-OBJASNJENJE-SRV: the same on the student's explanation of a finding.
  "work.assistant-match-explanation.post": {
    method: "POST",
    path: "/api/v1/works/izmisljeni-rad-0001/assistant-match/explanation",
    body: () => ({
      segmentRef: "blok-1",
      messageId: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c41",
      text: "Izmišljeno objašnjenje.",
    }),
    live: 404,
  },
  // PIL-P1-RITAM-SRV: a live session that has no such work or assignment gets 404 on each rhythm route.
  "work.input-rhythm.post": {
    method: "POST",
    path: "/api/v1/works/izmisljeni-rad-0001/input-rhythm",
    body: () => ({ gapsMs: [120, 80] }),
    live: 404,
  },
  "work.input-rhythm.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/input-rhythm",
    body: () => undefined,
    live: 404,
  },
  "work.input-rhythm.delete": {
    method: "DELETE",
    path: "/api/v1/works/izmisljeni-rad-0001/input-rhythm",
    body: () => undefined,
    live: 404,
  },
  "work.input-rhythm-setting.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/input-rhythm/setting",
    body: () => undefined,
    live: 404,
  },
  "teacher.input-rhythm.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/input-rhythm`,
    body: () => undefined,
    live: 404,
  },
  "teacher.input-rhythm.put": {
    method: "PUT",
    path: `/api/v1/teacher/assignments/${randomUUID()}/input-rhythm`,
    body: () => ({ enabled: false }),
    live: 404,
  },
  // PIL-P1-RITAM-PREDMET-SRV: no such assignment or course for the live session: 404.
  "teacher.input-rhythm.delete": {
    method: "DELETE",
    path: `/api/v1/teacher/assignments/${randomUUID()}/input-rhythm`,
    body: () => undefined,
    live: 404,
  },
  "teacher.course-input-rhythm.get": {
    method: "GET",
    path: `/api/v1/teacher/courses/${randomUUID()}/input-rhythm`,
    body: () => undefined,
    live: 404,
  },
  "teacher.course-input-rhythm.put": {
    method: "PUT",
    path: `/api/v1/teacher/courses/${randomUUID()}/input-rhythm`,
    body: () => ({ enabled: false }),
    live: 404,
  },
  // PIL-K-IZJAVA-SRV: a live session that teaches no such assignment gets 404 and changes nothing.
  "teacher.declaration-required.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/declaration-required`,
    body: () => undefined,
    live: 404,
  },
  "teacher.declaration-required.put": {
    method: "PUT",
    path: `/api/v1/teacher/assignments/${randomUUID()}/declaration-required`,
    body: () => ({ required: true }),
    live: 404,
  },
  // SRV-IZJAVA-PITANJE: a live session that teaches no such assignment gets 404 and changes nothing.
  "teacher.declaration-question.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/declaration-question`,
    body: () => undefined,
    live: 404,
  },
  "teacher.declaration-question.put": {
    method: "PUT",
    path: `/api/v1/teacher/assignments/${randomUUID()}/declaration-question`,
    body: () => ({ question: "Izmišljeno pitanje?" }),
    live: 404,
  },
  // SRV-NF4-KASNA-POLJE: a live session with no relation to such an assignment gets 404.
  "institution.assignment-late-submission.put": {
    method: "PUT",
    path: `/api/v1/institution/assignments/${randomUUID()}/late-submission`,
    body: () => ({ lateSubmissionAllowed: false }),
    live: 404,
  },
  "student.assignment-late-submission.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/late-submission`,
    body: () => undefined,
    live: 404,
  },
  // F4-NAS-R01-SRV: the same for the teacher's read.
  "teacher.assignment-late-submission.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/late-submission`,
    body: () => undefined,
    live: 404,
  },
  // SRV-ASIST-PREKIDAC: a live session with no relation to such a course or assignment gets 404.
  "teacher.course-assistant.get": {
    method: "GET",
    path: `/api/v1/teacher/courses/${randomUUID()}/assistant`,
    body: () => undefined,
    live: 404,
  },
  "teacher.course-assistant.put": {
    method: "PUT",
    path: `/api/v1/teacher/courses/${randomUUID()}/assistant`,
    body: () => ({ enabled: false }),
    live: 404,
  },
  "student.assignment-assistant.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/assistant`,
    body: () => undefined,
    live: 404,
  },
  "student.assignment-assistant-requests.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/assistant/requests`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V18-UPITNIK-ISPUNJAVANJE: a live session with no such questionnaire gets 404.
  "student.questionnaires.get": {
    method: "GET",
    path: "/api/v1/student/questionnaires",
    body: () => undefined,
    live: 200,
  },
  "student.questionnaire.get": {
    method: "GET",
    path: `/api/v1/student/questionnaires/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "student.questionnaire-responses.post": {
    method: "POST",
    path: `/api/v1/student/questionnaires/${randomUUID()}/responses`,
    body: () => ({ answers: [{ questionId: randomUUID(), value: "a" }] }),
    live: 404,
  },
  "teacher.questionnaire-manual-responses.post": {
    method: "POST",
    path: `/api/v1/teacher/questionnaires/${randomUUID()}/responses/manual`,
    body: () => ({ answers: [{ questionId: randomUUID(), value: "a" }] }),
    live: 404,
  },
  // SRV-V18-UPITNIK-IZVOZ: a live session with no such questionnaire gets 404.
  "teacher.questionnaire-export.get": {
    method: "GET",
    path: `/api/v1/teacher/questionnaires/${randomUUID()}/export`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V18-KODIRANJE-GRADIVO: the student's own material; an id that is not theirs is 404.
  "student.qual-materials.get": {
    method: "GET",
    path: "/api/v1/student/qual/materials",
    body: () => undefined,
    live: 200,
  },
  "student.qual-materials.post": {
    method: "POST",
    path: "/api/v1/student/qual/materials",
    body: () => ({ title: "Izmišljeni intervju", kind: "interview", text: "Izmišljeni tekst." }),
    live: 201,
  },
  "student.qual-material.get": {
    method: "GET",
    path: `/api/v1/student/qual/materials/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "student.qual-material.delete": {
    method: "DELETE",
    path: `/api/v1/student/qual/materials/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  // SRV-V18-KODIRANJE-OZNAKE: the passages and the export are the student's own; an id that is not theirs is 404.
  "student.qual-segments.get": {
    method: "GET",
    path: `/api/v1/student/qual/materials/${randomUUID()}/segments`,
    body: () => undefined,
    live: 404,
  },
  "student.qual-segments.post": {
    method: "POST",
    path: `/api/v1/student/qual/materials/${randomUUID()}/segments`,
    body: () => ({
      codeId: randomUUID(),
      anchor: { paragraph: 0, start: 0, end: 10, quote: "Izmišljena" },
    }),
    live: 404,
  },
  "student.qual-segment.delete": {
    method: "DELETE",
    path: `/api/v1/student/qual/segments/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "student.qual-export.get": {
    method: "GET",
    path: "/api/v1/student/qual/export",
    body: () => undefined,
    live: 200,
  },
  // SRV-1107: a live session that teaches no such work gets 404 on each criteria route.
  "course.aggregate.get": {
    method: "GET",
    path: `/api/v1/courses/${COURSE}/aggregate`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1906: every account is an operator in this file (step 8 below), so a
  // live session reads the numbers and the old cookie reaches the database.
  "ops.pilot-metrics.get": {
    method: "GET",
    path: "/api/v1/ops/pilot-metrics",
    body: () => undefined,
    live: 200,
  },
  // SRV-V15-HTTP: the stateless analysis, mounted switched on in this file; the
  // session is read and nothing else of the database, so the old cookie is 401.
  "analysis.catalogue.get": {
    method: "GET",
    path: "/api/v1/analysis/catalogue",
    body: () => undefined,
    live: 200,
  },
  "analysis.runs.post": {
    path: "/api/v1/analysis/runs",
    body: () => ({
      analysisId: "descriptive",
      analysisVersion: "1.0.0",
      variables: ["x"],
      columns: [{ name: "x", kind: "numeric" }],
      rows: [[1], [2], [3]],
    }),
    live: 200,
  },
  "teacher.working-criteria.get": {
    method: "GET",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/working-criteria",
    body: () => undefined,
    live: 404,
  },
  "teacher.working-criterion.put": {
    method: "PUT",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/working-criteria/sources",
    body: () => ({ assessment: 1, note: null }),
    live: 404,
  },
  "work.imports.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/imports",
    body: () => undefined,
    live: 404,
  },
  "student.working-criteria.get": {
    method: "GET",
    path: "/api/v1/student/works/izmisljeni-rad-0001/working-criteria",
    body: () => undefined,
    live: 404,
  },
  "work.revision-due.get": {
    method: "GET",
    path: "/api/v1/works/izmisljeni-rad-0001/revision-due",
    body: () => undefined,
    live: 404,
  },
  "teacher.work-rubric.get": {
    method: "GET",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/rubric",
    body: () => undefined,
    live: 404,
  },
  "teacher.work-rubric-mark.put": {
    method: "PUT",
    path: "/api/v1/teacher/works/izmisljeni-rad-0001/rubric/sources",
    body: () => ({ level: 1, note: null }),
    live: 404,
  },
  // SRV-7C: a live session that is no student of the work gets 404 on each source route.
  "student.work-sources.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/sources`,
    body: () => undefined,
    live: 404,
  },
  "student.work-sources.put": {
    method: "PUT",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/sources/${WORK_SOURCE.id}`,
    body: () => ({ record: WORK_SOURCE }),
    live: 404,
  },
  "student.work-sources.delete": {
    method: "DELETE",
    path: `/api/v1/student/assignments/${ASSIGNMENT}/sources/${WORK_SOURCE.id}`,
    body: () => undefined,
    live: 404,
  },
  "work.source-notes.get": { method: "GET", path: SOURCE_NOTES, body: () => undefined, live: 404 },
  "work.source-notes.post": {
    method: "POST",
    path: SOURCE_NOTES,
    body: () => ({ note: "Izmišljena bilješka." }),
    live: 404,
  },
  "work.source-notes.patch": {
    method: "PATCH",
    path: SOURCE_NOTES,
    body: () => ({ noteId: SOURCE_NOTE_ID, page: "12–14" }),
    live: 404,
  },
  "work.source-notes.delete": {
    method: "DELETE",
    path: `${SOURCE_NOTES}?noteId=${SOURCE_NOTE_ID}`,
    body: () => undefined,
    live: 404,
  },
  // SRV-22: a live session naming an assignment it is no student of gets 404.
  "student.submission.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/submission`,
    body: () => undefined,
    live: 404,
  },
  // SRV-30: a live session that reads no work of that student gets 404 (ZD403).
  "teacher.submission-receipt.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/students/${randomUUID()}/submission`,
    body: () => undefined,
    live: 404,
  },
  // The receipt PDF reads through the same readers: no submission of the caller is 404.
  "student.receipt-pdf.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/submission/pdf`,
    body: () => undefined,
    live: 404,
  },
  "teacher.receipt-pdf.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/submissions/${randomUUID()}/pdf`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1213: a live session that may not read that declaration gets 404 (ZD403).
  "teacher.declaration.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/students/${randomUUID()}/declaration`,
    body: () => undefined,
    live: 404,
  },
  // F4-PRE-R06-SRV: the same for its declaration-v2 read.
  "teacher.declaration-second.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/students/${randomUUID()}/declaration-v2`,
    body: () => undefined,
    live: 404,
  },
  // F4-NAS-R04-SRV: the same for a conversation of that declaration.
  "teacher.declaration-conversation.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/students/${randomUUID()}/declaration/conversations/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  // SRV-F4-NAS-R11: a live session that may not read that student's notes gets 404 (ZD403).
  "teacher.submission-notes.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/students/${randomUUID()}/submission-notes`,
    body: () => undefined,
    live: 404,
  },
  // SRV-ASIST-CITANJE: a live session naming an assignment it is no student of gets 404.
  "student.assistant-conversations.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/assistant-conversations`,
    body: () => undefined,
    live: 404,
  },
  // SRV-NG: a live session naming an assignment it is no student of gets 404.
  "student.notice.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/notice`,
    body: () => undefined,
    live: 404,
  },
  "student.assignment-requirements.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/requirements`,
    body: () => undefined,
    live: 404,
  },
  // SRV-NF1-PREDANO: the own list answers a live session, empty or not.
  "student.assignment-submissions.get": {
    method: "GET",
    path: "/api/v1/student/assignment-submissions",
    body: () => undefined,
    live: 200,
  },
  // DAN-826-2b: a live session that is not a network engineer gets 404 and
  // writes nothing, so the accounts of this file keep no settings row.
  "settings.values.put": {
    method: "PUT",
    path: "/api/v1/settings/values",
    body: () => ({
      level: "network_security",
      course: null,
      key: "network.session_idle_minutes",
      value: 60,
      locked: false,
      min: null,
      max: null,
    }),
    live: 404,
  },
  "settings.catalogue.get": {
    method: "GET",
    path: "/api/v1/settings/catalogue",
    body: () => undefined,
    live: 200,
  },
  "settings.values.get": {
    method: "GET",
    path: "/api/v1/settings/values?level=personal",
    body: () => undefined,
    live: 200,
  },
  // DAN-851-1d2: the interface language. A live POST saves `en` for the
  // account; the old cookie's POST sends `hr`, which must never land.
  "profile.interface-locale.get": {
    method: "GET",
    path: "/api/v1/profile/interface-locale",
    body: () => undefined,
    live: 200,
  },
  "profile.interface-locale.post": {
    path: "/api/v1/profile/interface-locale",
    body: () => ({ locale: "en" }),
    live: 200,
  },
  // Ductus#2028 c.6993786629 §3.3: the signed-in account; it only reads.
  "profile.me.get": {
    method: "GET",
    path: "/api/v1/me",
    body: () => undefined,
    live: 200,
  },
  // SRV-1403: the caller's own staff affiliation; it only reads.
  "profile.staff-affiliation.get": {
    method: "GET",
    path: "/api/v1/me/staff-affiliation",
    body: () => undefined,
    live: 200,
  },
  // DAN-851-2d2a: the problem report. The body is its JCS form (keys in
  // order), which the service asks for; a live report is 201 and stored.
  "support.problem-report.post": {
    path: "/api/v1/support/problem-report",
    body: () => ({
      appVersion: "1.4.0",
      browser: { family: "firefox", major: 140 },
      category: "technical",
      description: "Izmišljeni opis: gumb za spremanje ne reagira.",
      route: "/zadaci",
      syncState: "SYNCED",
    }),
    live: 201,
  },
  "support.problem-reports.post": {
    path: "/api/v1/problem-reports",
    body: () => ({
      appVersion: "1.4.0",
      category: "technical",
      description: "Izmišljeni problem s unosom.",
    }),
    live: 201,
  },
  // DAN-852-5a: the course routes. The accounts here hold no teacher role and
  // no course, so a live session is 403 forbidden from each RPC and writes nothing.
  "institution.courses.post": {
    path: "/api/v1/institution/courses",
    body: () => ({ name: "Izmišljeni kolegij", academicYear: "2026/2027", aiPolicy: "encouraged" }),
    live: 403,
  },
  "institution.enrollment-code.post": {
    path: `/api/v1/institution/courses/${COURSE}/enrollment-code`,
    body: () => ({ validUntil: "2099-12-31T23:59:59Z" }),
    live: 403,
  },
  "institution.enrollment-code-revocation.post": {
    path: `/api/v1/institution/courses/${COURSE}/enrollment-code/revocation`,
    body: () => ({}),
    live: 403,
  },
  // INT-32: the course's code state; the account teaches no course, so it is 404.
  "institution.enrollment-code-state.get": {
    method: "GET",
    path: `/api/v1/institution/courses/${COURSE}/enrollment-code/state`,
    body: () => undefined,
    live: 404,
  },
  // SRV-ULOGA-POTVRDA-OPOZIV: the account is no administrator, so both are 403.
  "institution.role-confirmation.post": {
    path: `/api/v1/institution/teachers/${STUDENT}/role-confirmation`,
    body: () => ({}),
    live: 403,
  },
  "institution.role-revocation.post": {
    path: `/api/v1/institution/teachers/${STUDENT}/role-revocation`,
    body: () => ({}),
    live: 403,
  },
  // Ductus#2028 (w1119o): the student and version routes on the same front.
  // The account teaches no course or assignment: each RPC refuses with 403.
  "institution.student-removal.post": {
    path: `/api/v1/institution/courses/${COURSE}/students/${STUDENT}/removal`,
    body: () => ({}),
    live: 403,
  },
  "institution.student-return.post": {
    path: `/api/v1/institution/courses/${COURSE}/students/${STUDENT}/return-permission`,
    body: () => ({}),
    live: 403,
  },
  // The work language routes: the account teaches no assignment, so 403.
  "institution.work-language.post": {
    path: `/api/v1/institution/assignments/${ASSIGNMENT}/work-language`,
    body: () => ({ expectedVersion: 1, language: "en" }),
    live: 403,
  },
  "institution.student-work-language.post": {
    path: `/api/v1/institution/assignments/${ASSIGNMENT}/students/${STUDENT}/work-language`,
    body: () => ({ language: "en" }),
    live: 403,
  },
  "institution.work-work-language.get": {
    method: "GET",
    path: `/api/v1/institution/assignments/${ASSIGNMENT}/works/izmisljeni-rad/work-language`,
    body: () => undefined,
    live: 403,
  },
  "institution.work-work-language.post": {
    path: `/api/v1/institution/assignments/${ASSIGNMENT}/works/izmisljeni-rad/work-language`,
    body: () => ({ language: null }),
    live: 403,
  },
  // The account mentors no work and has no visible submissions.
  "teacher.mentorships.get": {
    method: "GET",
    path: "/api/v1/teacher/mentorships",
    body: () => undefined,
    live: 200,
  },
  "teacher.mentorship.get": {
    method: "GET",
    path: `/api/v1/teacher/mentorships/${ASSIGNMENT}`,
    body: () => undefined,
    live: 404,
  },
  "teacher.submissions.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${ASSIGNMENT}/submissions`,
    body: () => undefined,
    live: 200,
  },
  "teacher.submission-detail.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${ASSIGNMENT}/submissions/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "teacher.course-students.get": {
    method: "GET",
    path: `/api/v1/teacher/courses/${ASSIGNMENT}/students`,
    body: () => undefined,
    live: 200,
  },
  "teacher.assignment-overview.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${ASSIGNMENT}/overview`,
    body: () => undefined,
    live: 200,
  },
  "teacher.assignment-follow-up.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${ASSIGNMENT}/follow-up`,
    body: () => undefined,
    live: 200,
  },
  // SRV-1306: a live session that is no administrator of the institution gets 403 (ZD403).
  "institution.admin-courses.get": {
    method: "GET",
    path: "/api/v1/institution/admin/courses?academicYear=2026%2F2027",
    body: () => undefined,
    live: 403,
  },
  "institution.academic-years.get": {
    method: "GET",
    path: "/api/v1/institution/admin/academic-years",
    body: () => undefined,
    live: 403,
  },
  "institution.teacher-roles.get": {
    method: "GET",
    path: "/api/v1/institution/teachers",
    body: () => undefined,
    live: 403,
  },
  // SRV-ADMIN-1: a live session with no reader position (no administrator,
  // network engineer or teacher role) reads no reports, changes no state and
  // reads no action log.
  "support.problem-reports.get": {
    method: "GET",
    path: "/api/v1/problem-reports",
    body: () => undefined,
    live: 403,
  },
  "support.problem-report-status.post": {
    path: "/api/v1/problem-reports/PR-0A1B2C3D4E/status",
    body: () => ({ status: "resolved" }),
    live: 403,
  },
  "institution.admin-actions.get": {
    method: "GET",
    path: "/api/v1/institution/admin-actions",
    body: () => undefined,
    live: 403,
  },
  "institution.legal-holds.get": {
    method: "GET",
    path: "/api/v1/institution/legal-holds",
    body: () => undefined,
    live: 403,
  },
  "institution.legal-holds.post": {
    path: "/api/v1/institution/legal-holds",
    body: () => ({
      subjectType: "work",
      subjectId: randomUUID(),
      caseReference: "IZMISLJENI-SLUCAJ-2026-01",
    }),
    live: 403,
  },
  "institution.legal-hold-release.post": {
    path: `/api/v1/institution/legal-holds/${randomUUID()}/release`,
    body: () => ({ reason: "Izmišljeni razlog." }),
    live: 403,
  },
  // SRV-1308: a live session that is no clerk of the registry office lists only its own
  // exports (200, none) and may neither request (403) nor approve (403, ZD403 before the lookup).
  "institution.student-data-exports.get": {
    method: "GET",
    path: "/api/v1/institution/student-data-exports",
    body: () => undefined,
    live: 200,
  },
  // SRV-NF7-IZVOZ-STUDENT: the same reach as the list, so the same 200 with none.
  "institution.student-data-export-students.get": {
    method: "GET",
    path: "/api/v1/institution/student-data-export-students",
    body: () => undefined,
    live: 200,
  },
  "institution.student-data-exports.post": {
    path: "/api/v1/institution/student-data-exports",
    body: () => ({
      studentId: randomUUID(),
      identityCheckedBy: "identity_card",
      note: "Provjera 1/2026",
    }),
    live: 403,
  },
  "institution.student-data-exports-approve.post": {
    path: `/api/v1/institution/student-data-exports/${randomUUID()}/approve`,
    body: () => ({ reference: "Posao 1/2026" }),
    live: 403,
  },
  // SRV-1108: a live session that teaches no such assignment gets 404.
  "teacher.deadline-extensions.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/deadline-extensions`,
    body: () => undefined,
    live: 404,
  },
  "teacher.deadline-extension.post": {
    path: `/api/v1/teacher/assignments/${randomUUID()}/deadline-extensions`,
    body: () => ({ scope: "all", dueAt: "2030-01-01T12:00:00.000Z", reasonId: "all" }),
    live: 404,
  },
  // SRV-NF4-IZNIMKA-ZAPIS: a live session that teaches or studies no such assignment gets 404.
  "teacher.late-exceptions.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/late-submission-exceptions`,
    body: () => undefined,
    live: 404,
  },
  "teacher.late-exception.post": {
    path: `/api/v1/teacher/assignments/${randomUUID()}/late-submission-exceptions`,
    body: () => ({
      studentId: randomUUID(),
      untilAt: "2030-01-01T12:00:00.000Z",
      reasonId: "agreement",
    }),
    live: 404,
  },
  "student.late-exceptions.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/late-submission-exceptions`,
    body: () => undefined,
    live: 404,
  },
  "student.deadline-history.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/deadline-extensions`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1903: a live session that is not a student or teacher of such an assignment gets 404.
  "student.submission-withdrawal.post": {
    path: `/api/v1/student/assignments/${randomUUID()}/submission/withdrawal`,
    body: () => undefined,
    live: 404,
  },
  "student.submission-withdrawal.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/submission/withdrawal`,
    body: () => undefined,
    live: 404,
  },
  "student.submission-history.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/submission/history`,
    body: () => undefined,
    live: 404,
  },
  "teacher.submission-history.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/students/${randomUUID()}/submission-history`,
    body: () => undefined,
    live: 404,
  },
  "teacher.submission-withdrawal.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/submission-withdrawal`,
    body: () => undefined,
    live: 404,
  },
  "teacher.submission-withdrawal.post": {
    path: `/api/v1/teacher/assignments/${randomUUID()}/submission-withdrawal`,
    body: () => ({ allowed: false }),
    live: 404,
  },
  // SRV-1904: a live session that teaches no such assignment gets 404.
  "teacher.assignment-copy.post": {
    path: `/api/v1/teacher/assignments/${randomUUID()}/copy`,
    body: () => ({ requestKey: randomUUID(), courseId: randomUUID() }),
    live: 404,
  },
  // SRV-1109: a live session that teaches no such assignment gets 404.
  "teacher.merlin-roster.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/merlin/roster`,
    body: () => undefined,
    live: 404,
  },
  "teacher.merlin-roster-csv.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/merlin/csv`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1110: a live session that teaches no such assignment gets 404.
  "teacher.merlin-packages.post": {
    path: `/api/v1/teacher/assignments/${randomUUID()}/merlin/packages`,
    body: () => ({ requestKey: randomUUID() }),
    live: 404,
  },
  "teacher.merlin-package.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/merlin/packages/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "teacher.merlin-package-download.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${randomUUID()}/merlin/packages/${randomUUID()}/download`,
    body: () => undefined,
    live: 404,
  },
  // SRV-1204: no provider in production, so a live session reads ai_disabled
  // (200) and a conversation nobody owns 404.
  "student.assistant-request.post": {
    path: "/api/v1/student/assistant/requests",
    headers: { "idempotency-key": randomUUID() },
    body: () => ({
      assignmentId: randomUUID(),
      conversationId: null,
      purposeCatalogVersion: 1,
      purposeKey: "proofreading",
      paragraph: "Izmišljeni odlomak.",
    }),
    live: 200,
  },
  "student.assistant-conversation.get": {
    method: "GET",
    path: `/api/v1/student/assistant/conversations/${randomUUID()}`,
    body: () => undefined,
    live: 404,
  },
  "student.declaration.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/declaration`,
    body: () => undefined,
    live: 404,
  },
  "student.declaration-conversations.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/declaration-conversations`,
    body: () => undefined,
    live: 404,
  },
  "student.declaration.put": {
    method: "PUT",
    path: `/api/v1/student/assignments/${randomUUID()}/declaration`,
    body: () => ({}),
    live: 422,
  },
  "student.declaration-second.get": {
    method: "GET",
    path: `/api/v1/student/assignments/${randomUUID()}/declaration-v2`,
    body: () => undefined,
    live: 404,
  },
  "student.declaration-second.put": {
    method: "PUT",
    path: `/api/v1/student/assignments/${randomUUID()}/declaration-v2`,
    body: () => ({}),
    live: 422,
  },
  "student.declaration-attachments.post": {
    path: `/api/v1/student/assignments/${randomUUID()}/declaration-attachments`,
    body: () => ({}),
    // A JSON body is not PDF or plain text (declaration-v1 §7.3, SRV-1213).
    live: 415,
  },
  "teacher.assignment-submissions.post": {
    path: "/api/v1/teacher/assignment-submissions",
    body: () => ({ assignmentIds: [ASSIGNMENT] }),
    live: 200,
  },
  "teacher.mentorship-requests.get": {
    method: "GET",
    path: "/api/v1/teacher/mentorship-requests",
    body: () => undefined,
    live: 200,
  },
  "teacher.mentorship-request-decision.post": {
    path: "/api/v1/teacher/mentorship-requests/decision",
    body: () => ({ requestId: ASSIGNMENT, decision: "approve" }),
    live: 403,
  },
  // Ductus#2028 (w1119o): the live view of a work the account does not own
  // or teach is the same 404 as a missing one. GET carries the protocol, PUT
  // the precondition of a first write and the exact JCS bytes of a document.
  "live.document.get": {
    method: "GET",
    path: "/api/v1/live/izmisljeni-rad-uzivo",
    body: () => undefined,
    headers: { "ductus-protocol": "1" },
    live: 404,
  },
  "live.document.put": {
    method: "PUT",
    path: "/api/v1/live/izmisljeni-rad-uzivo",
    body: () => LIVE_DOCUMENT,
    headers: { "if-none-match": "*" },
    live: 404,
  },
  // Ductus#2028 (w1119o): the notice of an assignment the account is not
  // enrolled in is refused by acknowledge_notice (403) and nothing is recorded.
  "institution.acknowledgment.post": {
    path: `/api/v1/institution/assignments/${ASSIGNMENT}/acknowledgment`,
    body: () => ({ versionNo: 1, fingerprint: "0".repeat(64) }),
    live: 403,
  },
  // DAN-840-3f1: WebAuthn. A live challenge is 200; a registration without a
  // challenge is 400 (the ceremony refuses it); an assertion of a key the
  // account does not hold is 403. The old cookie's registration carries a
  // valid ceremony (T1), so its 401 comes from the database, not the check.
  "auth.webauthn-challenge.post": {
    path: "/api/v1/auth/webauthn/challenge",
    body: () => ({ purpose: "assertion" }),
    live: 200,
  },
  "auth.webauthn-registration.post": {
    path: "/api/v1/auth/webauthn/registration",
    body: () => ({ clientDataJSON: "AA", authenticatorData: "AA", credentialId: "AA" }),
    live: 400,
  },
  "auth.webauthn-assertion.post": {
    path: "/api/v1/auth/webauthn/assertion",
    body: () => ({
      clientDataJSON: "AA",
      authenticatorData: "AA",
      credentialId: "AA",
      signature: "AA",
    }),
    live: 403,
  },
  // SRV-13: the teacher's reads. An account without the teacher role reads
  // 404 from list_teacher_courses and "denied" from the access check.
  "teacher.courses.get": {
    method: "GET",
    path: "/api/v1/teacher/courses",
    body: () => undefined,
    live: 404,
  },
  "teacher.access.get": {
    method: "GET",
    path: "/api/v1/teacher/access",
    body: () => undefined,
    live: 200,
  },
  // SRV-14: a new assignment and a next version; no role and no course, so
  // a live session is 403 from each RPC and writes nothing.
  "institution.course-assignments.post": {
    path: `/api/v1/institution/courses/${COURSE}/assignments`,
    body: () => ({
      requestKey: randomUUID(),
      ...{
        title: "Izmišljeni zadatak",
        instructions: "Izmišljene upute.",
        workType: "essay",
        opensAt: "2026-11-01T08:00:00+01:00",
        dueAt: "2027-02-28T23:59:00+01:00",
        aiPolicy: "encouraged",
        aiPurposes: [],
        evidenceProfile: "basic",
        importAllowed: false,
        wordMin: null,
        wordMax: null,
      },
    }),
    live: 403,
  },
  "sources.lookup.post": {
    path: "/api/v1/sources/lookup",
    body: () => ({ kind: "doi", identifier: "10.99999/izmisljeni" }),
    live: 503,
  },
  "institution.assignment.get": {
    method: "GET",
    path: `/api/v1/institution/assignments/${ASSIGNMENT}`,
    body: () => undefined,
    live: 404,
  },
  "teacher.assignment-grade.get": {
    method: "GET",
    path: `/api/v1/teacher/assignments/${ASSIGNMENT}/grade`,
    body: () => undefined,
    live: 404,
  },
  "institution.assignment-versions.post": {
    path: `/api/v1/institution/assignments/${COURSE}/versions`,
    body: () => ({
      expectedVersion: 1,
      ...{
        title: "Izmišljeni zadatak",
        instructions: "Izmišljene upute.",
        workType: "essay",
        opensAt: "2026-11-01T08:00:00+01:00",
        dueAt: "2027-02-28T23:59:00+01:00",
        aiPolicy: "encouraged",
        aiPurposes: [],
        evidenceProfile: "basic",
        importAllowed: false,
        wordMin: null,
        wordMax: null,
      },
    }),
    live: 403,
  },
  // SRV-15: the seminar groups; not a teacher of any course, so 403.
  "institution.course-groups.post": {
    path: `/api/v1/institution/courses/${COURSE}/groups`,
    body: () => ({ name: "Izmišljena grupa" }),
    live: 403,
  },
  "institution.course-group-teachers.post": {
    path: `/api/v1/institution/groups/${COURSE}/teachers`,
    body: () => ({ teacherId: randomUUID() }),
    live: 403,
  },
  // Not of the course team nor an administrator: 403 from course_groups.
  "institution.course-groups.get": {
    method: "GET",
    path: `/api/v1/institution/courses/${COURSE}/groups`,
    body: () => undefined,
    live: 403,
  },
  // SRV-2001: the faculty rules; not an administrator, so 403.
  "institution.faculty-rules.get": {
    method: "GET",
    path: "/api/v1/institution/faculty-rules",
    body: () => undefined,
    live: 403,
  },
  // SRV-ADMIN-3: the faculty's assistant setting; not an administrator, so 403.
  "institution.assistant-setting.get": {
    method: "GET",
    path: "/api/v1/institution/assistant-setting",
    body: () => undefined,
    live: 403,
  },
  "institution.faculty-rules.post": {
    path: "/api/v1/institution/faculty-rules",
    body: () => ({
      workType: "essay",
      basedOnVersionNo: null,
      aiPolicy: "prohibited",
      aiPurposes: [],
      evidenceProfile: "basic",
      importAllowed: false,
    }),
    live: 403,
  },
  // SRV-1406: the rules of the institution; not an administrator, so 403.
  "institution.config.get": {
    method: "GET",
    path: "/api/v1/institution/config",
    body: () => undefined,
    live: 403,
  },
  "institution.config-versions.post": {
    path: "/api/v1/institution/config/versions",
    body: () => ({
      expectedVersion: 0,
      citationStyle: "fpzg",
      workLanguages: ["hr"],
      defaultWorkLanguage: "hr",
    }),
    live: 403,
  },
  // SRV-ASIST-LIMIT-ADMIN: the administrator's request limit; not an administrator, so 403.
  "institution.assistant-request-limit.get": {
    method: "GET",
    path: "/api/v1/institution/assistant/request-limit",
    body: () => undefined,
    live: 403,
  },
  "institution.assistant-request-limit.put": {
    method: "PUT",
    path: "/api/v1/institution/assistant/request-limit",
    body: () => ({ expectedVersion: 0, limit: 5 }),
    live: 403,
  },
  // SRV-12: the administrator's course; not an administrator, so 403.
  "institution.admin-courses.post": {
    path: "/api/v1/institution/admin/courses",
    body: () => ({
      name: "Izmišljeni kolegij",
      academicYear: "2026/2027",
      aiPolicy: "encouraged",
      holderId: randomUUID(),
      groups: [],
    }),
    live: 403,
  },
  // SRV-ADMIN-2: the administrator's roster import; not an administrator, so 403.
  "institution.roster-imports.post": {
    path: `/api/v1/institution/admin/courses/${COURSE}/roster-imports`,
    body: () => ({ source: "merlin", csv: "identifikator;ime;prezime\r\n" }),
    live: 403,
  },
  "institution.roster-import-confirm.post": {
    path: `/api/v1/institution/admin/roster-imports/${randomUUID()}/confirm`,
    body: () => ({}),
    live: 403,
  },
  // SRV-V22-ISVU-POPIS: the trial ISVU source; not an administrator, so 403 (before the setting is read).
  "institution.isvu-courses.get": {
    method: "GET",
    path: "/api/v1/institution/admin/isvu/courses?academicYear=2026%2F2027",
    body: () => undefined,
    live: 403,
  },
  "institution.isvu-roster-imports.post": {
    path: `/api/v1/institution/admin/courses/${COURSE}/isvu-roster-imports`,
    body: () => ({ sourceCourseKey: "SYN-101" }),
    live: 403,
  },
  // SRV-1304: the administrator's retention dry run; not an administrator, so 403.
  "institution.retention.get": {
    method: "GET",
    path: "/api/v1/institution/retention",
    body: () => undefined,
    live: 403,
  },
} as const;
type SessionRouteId = keyof typeof SESSION_ROUTES;
const SESSION_IDS = Object.keys(SESSION_ROUTES) as SessionRouteId[];

/** The route factories server/server.ts calls in its `routes` list, in order. */
const FACTORIES = [
  "createHealthRoute",
  "createReadyRoute",
  "createStatusRouteFor",
  "createClientContextRoute",
  "createClientErrorRoute",
  "createEvidenceOpenRoute",
  "createStudentAssignmentWorkRouteFor",
  "createStudentNotesRoutesFor",
  "createWorkSourceRoutesFor",
  "createSourceNotebookRoutesFor",
  "createSourceProofRoutesFor",
  "createTextCheckConfigRoute",
  "createTeacherWorkRoutesFor",
  "createOriginCompositionRoutesFor",
  "createAssistantMatchRoutesFor",
  "createInputRhythmRoutesFor",
  "createRevisionRestoreRouteFor",
  "createFacultyThresholdRoutesFor",
  "createTeacherSourceRoutesFor",
  "createTeacherWorkingCriteriaRoutesFor",
  "createWorkRevisionDueRoutesFor",
  "createSourceLookupRouteFor",
  "createPublicVerificationRouteFor",
  "createDownloadsManifestRoute",
  "createSettingsValuesPutRoute",
  "createSettingsReadRoutes",
  "createInterfaceLocaleRoutesFor",
  "createProblemReportRouteFor",
  "createProblemReportsRouteFor",
  "createInstitutionCourseRoutesFor",
  "createEnrollmentCodeStateRouteFor",
  "createTeacherRoleRoutesFor",
  "createInstitutionAssignmentRoutesFor",
  "createAssignmentCurrentVersionRouteFor",
  "createAssignmentGradeRouteFor",
  "createInstitutionGroupRoutesFor",
  "createAdminCourseRouteFor",
  "createRosterImportRoutesFor",
  "createIsvuSourceRoutesFor",
  "createLiveRoutesFor",
  "createCollaborationCommentsRouteFor",
  "createRevisionRequestsRouteFor",
  "createRevisionSendRouteFor",
  "createWorkMessagesRoutesFor",
  "createMentorshipFollowRoutesFor",
  "createWorkPlanRoutesFor",
  "createSelfNoteSealedRoutesFor",
  "createNotificationsRoutesFor",
  "createCommentRoutesFor",
  "createDirectEditRoutesFor",
  "createSuggestionRoutesFor",
  "createImportRoutesFor",
  "createConsultationRecordRoutesFor",
  "createEventDisputeRoutesFor",
  "createWorkMilestonesRoutesFor",
  "createMilestoneTemplateRoutesFor",
  "createAssignmentRubricRoutesFor",
  "createAssignmentCodeTestsRoutesFor",
  "createQuestionnaireRoutesFor",
  "createWorkRubricRoutesFor",
  "createWorkTemplateRoutesFor",
  "createAssignmentTemplateRoutesFor",
  "createFormatRulesRoutesFor",
  "createReturnForRevisionRoutesFor",
  "createAcknowledgmentRouteFor",
  "createWebAuthnRoutesFor",
  "createEvidenceCommitRouteFor",
  "createEvidenceReplayRouteFor",
  "createWorkVersionsRouteFor",
  "createWorkExportRouteFor",
  "createSheetCsvRouteFor",
  "createSheetXlsxRouteFor",
  "createWorkExportSlidesRouteFor",
  "createPortableRecordRouteFor",
  "createSubmissionPackageRoutesFor",
  "createWorkPdfRouteFor",
  "createWorkVersionRouteFor",
  "createWorkCompareRouteFor",
  "createConsultationSlotRoutesFor",
  "createWorkInterviewRoutesFor",
  "createWorkInterviewPdfRouteFor",
  "createMentorshipRequestRoutesFor",
  "createMentorshipStudentRoutesFor",
  "createMentorshipConsultationRoutesFor",
  "createStudentWorkRoutesFor",
  "createKeyDatesRoutesFor",
  "createTeachingTeamRoutesFor",
  "createMentorNotesRoutesFor",
  "createPracticeJournalRoutesFor",
  "createWorkTeamRoutesFor",
  "createPeerReviewRoutesFor",
  "createQualitativeCodesRoutesFor",
  "createThesisRoutesFor",
  "createThesisTopicRoutesFor",
  "createThesisCommitteeRoutesFor",
  "createThesisOverviewRoutesFor",
  "createAttachmentRoutesFor",
  "createSubmissionRouteFor",
  "createSubmissionRouteFor",
  "createDeclarationRequiredRoutesFor",
  "createDeclarationQuestionRoutesFor",
  "createLateSubmissionRoutesFor",
  "createCourseAssistantRoutesFor",
  "createQuestionnaireResponsesRoutesFor",
  "createQuestionnaireExportRoutesFor",
  "createQualitativeMaterialsRoutesFor",
  "createQualitativeSegmentsRoutesFor",
  "createProcessSummaryRouteFor",
  "createProcessSummaryDetailsRouteFor",
  "createTeacherFastPathRouteFor",
  "createStudentSubmissionRoutesFor",
  "createReceiptPdfRoutesFor",
  "createStudentNoticeRouteFor",
  "createStudentAssignmentsRouteFor",
  "createStudentMentoredAssignmentsRouteFor",
  "createStudentAccessLogRouteFor",
  "createStudentWriteRoutesFor",
  "createMeRouteFor",
  "createStaffAffiliationRouteFor",
  "createTeacherReadRoutesFor",
  "createTeacherSubmissionDetailRouteFor",
  "createTeacherDeclarationRouteFor",
  "createTeacherDeclarationV2RouteFor",
  "createTeacherDeclarationConversationRouteFor",
  "createTeacherSubmissionNotesRouteFor",
  "createCourseAggregateRouteFor",
  "createPilotMetricsRouteFor",
  "createAnalysisRoutesFor",
  "createProblemReportInboxRoutesFor",
  "createAdminActionLogRouteFor",
  "createRetentionRouteFor",
  "createFacultyRuleRoutesFor",
  "createAssistantSettingRouteFor",
  "createInstitutionConfigRoutesFor",
  "createWorkAccessRouteFor",
  "createTeacherRosterRoutesFor",
  "createInstitutionReadRoutesFor",
  "createDeadlineExtensionRoutesFor",
  "createLegalHoldRoutesFor",
  "createStudentDataExportRoutesFor",
  "createStudentDeadlineHistoryRouteFor",
  "createSubmissionWithdrawalRoutesFor",
  "createAssignmentCopyRouteFor",
  "createMerlinRosterRoutesFor",
  "createMerlinPackageRoutesFor",
  "createTeacherSubmissionsBulkRoutesFor",
  "createAssistantRoutesFor",
  "createStudentConversationsRouteFor",
  "createStatementRoutesFor",
  "createTeacherMentorshipRequestRoutesFor",
  "createWorkAccommodationRoutesFor",
  "createInternalInstitutionRoutes",
  "createAuthRoutes",
  "routesOf",
];
const evidenceDeps = evidenceIngestDependencies(ENV, ROOT);
const MOUNTED = [
  createHealthRoute({ health: databases.health, serverVersion: "0.1.0" }),
  // Public readiness; no session, so no 401 in its contract.
  createReadyRoute({
    check: async () => ({ ready: true, capabilities: {}, codes: {} }),
    draining: () => false,
  }),
  createStatusRouteFor(
    databases.main,
    async () => ({ ready: true, capabilities: {}, codes: {} }),
    () => false,
  ),
  createClientContextRoute(),
  createClientErrorRoute(),
  createEvidenceOpenRoute(databases.main),
  createStudentAssignmentWorkRouteFor(databases.main),
  ...createStudentNotesRoutesFor(databases.main),
  ...createWorkSourceRoutesFor(databases.main),
  ...createSourceNotebookRoutesFor(databases.main),
  ...createSourceProofRoutesFor(databases.main),
  createTextCheckConfigRoute(databases.main),
  ...createTeacherWorkRoutesFor(databases.main),
  ...createOriginCompositionRoutesFor(databases.main),
  ...createAssistantMatchRoutesFor(databases.main),
  ...createInputRhythmRoutesFor(databases.main),
  ...createFacultyThresholdRoutesFor(databases.main),
  ...createTeacherSourceRoutesFor(databases.main),
  ...createTeacherWorkingCriteriaRoutesFor(databases.main),
  ...createWorkRevisionDueRoutesFor(databases.main),
  createSourceLookupRouteFor(databases.main, ENV),
  createPublicVerificationRouteFor(databases.main),
  createDownloadsManifestRoute(),
  createSettingsValuesPutRoute({ writer: databases.main.settingsWriter }),
  ...createSettingsReadRoutes(databases.main),
  ...createInterfaceLocaleRoutesFor(databases.main),
  createProblemReportRouteFor(databases.main),
  createProblemReportsRouteFor(databases.main),
  ...createInstitutionCourseRoutesFor(databases.main),
  createEnrollmentCodeStateRouteFor(databases.main),
  ...createTeacherRoleRoutesFor(databases.main),
  ...createInstitutionAssignmentRoutesFor(databases.main),
  createAssignmentCurrentVersionRouteFor(databases.main),
  createAssignmentGradeRouteFor(databases.main),
  ...createInstitutionGroupRoutesFor(databases.main),
  createAdminCourseRouteFor(databases.main),
  ...createRosterImportRoutesFor(databases.main),
  ...createIsvuSourceRoutesFor(databases.main),
  ...createLiveRoutesFor(databases.main),
  createCollaborationCommentsRouteFor(databases.main),
  createRevisionRequestsRouteFor(databases.main),
  createRevisionSendRouteFor(databases.main),
  ...createWorkMessagesRoutesFor(databases.main),
  ...createMentorshipFollowRoutesFor(databases.main),
  ...createWorkPlanRoutesFor(databases.main),
  ...createSelfNoteSealedRoutesFor(databases.main),
  ...createNotificationsRoutesFor(databases.main),
  ...createCommentRoutesFor(databases.main, evidenceDeps),
  ...createDirectEditRoutesFor(databases.main),
  ...createSuggestionRoutesFor(databases.main),
  ...createImportRoutesFor(databases.main),
  ...createConsultationRecordRoutesFor(databases.main),
  ...createEventDisputeRoutesFor(databases.main),
  ...createWorkMilestonesRoutesFor(databases.main),
  ...createMilestoneTemplateRoutesFor(databases.main),
  ...createAssignmentRubricRoutesFor(databases.main),
  ...createAssignmentCodeTestsRoutesFor(databases.main),
  ...createQuestionnaireRoutesFor(databases.main),
  ...createWorkRubricRoutesFor(databases.main),
  ...createWorkTemplateRoutesFor(databases.main),
  ...createAssignmentTemplateRoutesFor(databases.main),
  ...createFormatRulesRoutesFor(databases.main),
  ...createReturnForRevisionRoutesFor(databases.main),
  createAcknowledgmentRouteFor(databases.main),
  ...createWebAuthnRoutesFor(databases.main, ORIGIN),
  createEvidenceCommitRouteFor(databases.main, evidenceDeps),
  createEvidenceReplayRouteFor(databases.main, evidenceDeps),
  createWorkVersionsRouteFor(databases.main),
  createRevisionRestoreRouteFor(databases.main),
  createWorkExportRouteFor(databases.main),
  createSheetCsvRouteFor(databases.main),
  createSheetXlsxRouteFor(databases.main),
  createWorkExportSlidesRouteFor(databases.main, process.env, process.cwd()),
  createPortableRecordRouteFor(databases.main, ORIGIN),
  ...createSubmissionPackageRoutesFor(databases.main, ORIGIN),
  createWorkPdfRouteFor(databases.main, undefined),
  createWorkVersionRouteFor(databases.main, evidenceDeps),
  createWorkCompareRouteFor(databases.main, evidenceDeps),
  ...createConsultationSlotRoutesFor(databases.main),
  ...createWorkInterviewRoutesFor(databases.main),
  createWorkInterviewPdfRouteFor(databases.main),
  ...createMentorshipRequestRoutesFor(databases.main),
  ...createMentorshipStudentRoutesFor(databases.main),
  ...createMentorshipConsultationRoutesFor(databases.main),
  ...createStudentWorkRoutesFor(databases.main),
  ...createKeyDatesRoutesFor(databases.main),
  ...createTeachingTeamRoutesFor(databases.main),
  ...createMentorNotesRoutesFor(databases.main),
  ...createPracticeJournalRoutesFor(databases.main),
  ...createWorkTeamRoutesFor(databases.main),
  ...createPeerReviewRoutesFor(databases.main),
  ...createQualitativeCodesRoutesFor(databases.main),
  ...createThesisRoutesFor(databases.main),
  ...createThesisTopicRoutesFor(databases.main),
  ...createThesisCommitteeRoutesFor(databases.main),
  ...createThesisOverviewRoutesFor(databases.main),
  ...createAttachmentRoutesFor(databases.main, ENV, ROOT),
  createSubmissionRouteFor(databases.main, evidenceDeps),
  createSubmissionRouteFor(databases.main, evidenceDeps, 2),
  ...createDeclarationRequiredRoutesFor(databases.main),
  ...createDeclarationQuestionRoutesFor(databases.main),
  ...createLateSubmissionRoutesFor(databases.main),
  ...createCourseAssistantRoutesFor(databases.main),
  ...createQuestionnaireResponsesRoutesFor(databases.main),
  ...createQuestionnaireExportRoutesFor(databases.main),
  ...createQualitativeMaterialsRoutesFor(databases.main),
  ...createQualitativeSegmentsRoutesFor(databases.main),
  createProcessSummaryRouteFor(databases.main, evidenceDeps, ENV),
  createProcessSummaryDetailsRouteFor(databases.main, evidenceDeps, ENV),
  createTeacherFastPathRouteFor(databases.main, evidenceDeps, ENV),
  ...createStudentSubmissionRoutesFor(databases.main),
  ...createReceiptPdfRoutesFor(databases.main, ORIGIN),
  createStudentNoticeRouteFor(databases.main),
  createStudentAssignmentsRouteFor(databases.main),
  createStudentMentoredAssignmentsRouteFor(databases.main),
  createStudentAccessLogRouteFor(databases.main),
  ...createStudentWriteRoutesFor(databases.main),
  createMeRouteFor(databases.main),
  createStaffAffiliationRouteFor(databases.main),
  ...createTeacherReadRoutesFor(databases.main),
  createTeacherSubmissionDetailRouteFor(databases.main),
  createTeacherDeclarationRouteFor(databases.main),
  createTeacherDeclarationV2RouteFor(databases.main),
  createTeacherDeclarationConversationRouteFor(databases.main),
  createTeacherSubmissionNotesRouteFor(databases.main),
  createCourseAggregateRouteFor(databases.main),
  createPilotMetricsRouteFor(databases.main),
  ...createAnalysisRoutesFor(databases.main, { enabled: true }),
  ...createProblemReportInboxRoutesFor(databases.main),
  createAdminActionLogRouteFor(databases.main),
  createRetentionRouteFor(databases.main),
  ...createFacultyRuleRoutesFor(databases.main),
  createAssistantSettingRouteFor(databases.main),
  ...createInstitutionConfigRoutesFor(databases.main),
  createWorkAccessRouteFor(databases.main),
  ...createTeacherRosterRoutesFor(databases.main),
  ...createInstitutionReadRoutesFor(databases.main),
  ...createDeadlineExtensionRoutesFor(databases.main),
  ...createLegalHoldRoutesFor(databases.main),
  ...createStudentDataExportRoutesFor(databases.main, ENV, ROOT),
  ...createSubmissionWithdrawalRoutesFor(databases.main, evidenceDeps),
  createStudentDeadlineHistoryRouteFor(databases.main),
  createAssignmentCopyRouteFor(databases.main),
  ...createMerlinRosterRoutesFor(databases.main),
  ...createMerlinPackageRoutesFor(databases.main),
  ...createTeacherSubmissionsBulkRoutesFor(databases.main, ORIGIN),
  ...createAssistantRoutesFor(databases.main),
  createStudentConversationsRouteFor(databases.main),
  ...createStatementRoutesFor(databases.main),
  ...createTeacherMentorshipRequestRoutesFor(databases.main),
  ...createWorkAccommodationRoutesFor(databases.main),
  ...createInternalInstitutionRoutes({ env: ENV }),
  ...createAuthRoutes(ENV),
  ...routesOf(AREA_NAMES),
];

let accounts = 0;
/** A fresh account (at most five live sessions each) and `count` of its sessions. */
async function signIn(count: number): Promise<string[]> {
  accounts += 1;
  const tokens: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const { token, tokenHash } = newSessionToken();
    const opened = await createOpenSession(auth)({
      issuer,
      subject: `sub-loc-${accounts}`,
      uniqueId: `osoba${accounts}@${homeOrg}`,
      homeOrg,
      teacherEligible: false,
      tokenHash,
    });
    if (!opened.ok) throw new Error(`openSession refused: ${opened.reason}`);
    tokens.push(token);
  }
  return tokens;
}

function post(
  path: string,
  token: string,
  body?: unknown,
  method = "POST",
  extra: Readonly<Record<string, string>> = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: ORIGIN,
    "sec-fetch-site": "same-origin",
    cookie: `__Host-ductus_session=${token}`,
    ...extra,
  };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
    headers["ductus-protocol"] = "1";
  }
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers,
    redirect: "manual",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const call = (id: SessionRouteId, token: string, body?: unknown) => {
  const route: {
    path: string;
    body: () => unknown;
    method?: string;
    headers?: Readonly<Record<string, string>>;
    form?: () => FormData;
    pathFor?: (token: string) => string;
  } = SESSION_ROUTES[id];
  // A multipart route (SRV-1102): fetch writes the form and its content type.
  if (route.form !== undefined)
    return fetch(`http://127.0.0.1:${server.port}${route.path}`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        cookie: `__Host-ductus_session=${token}`,
      },
      body: route.form(),
    });
  const path = route.pathFor?.(token) ?? route.path;
  return post(path, token, body ?? route.body(), route.method, route.headers);
};

const LOCALE = "/api/v1/profile/interface-locale";
/** The saved interface language of a session's account, read as the admin. */
const savedLocale = async (token: string) =>
  (
    await admin.query<{ locale: string }>(
      `SELECT p.interface_locale AS locale FROM identity.user_preference p
         JOIN identity.session s ON s.user_id = p.user_id
        WHERE s.token_hash = sha256(convert_to($1, 'UTF8'))`,
      [token],
    )
  ).rows.map((row) => row.locale);

/** How many problem reports a session's account has stored, read as the admin. */
const storedReports = async (token: string) =>
  Number(
    (
      await admin.query<{ n: string }>(
        `SELECT count(*) AS n FROM identity.problem_report r
           JOIN identity.session s ON s.user_id = r.user_id
          WHERE s.token_hash = sha256(convert_to($1, 'UTF8'))`,
        [token],
      )
    ).rows[0]?.n,
  );

const sessionEnd = async (token: string) =>
  (
    await admin.query<{ reason: string | null; closedAt: Date | null }>(
      `SELECT close_reason AS reason, closed_at AS "closedAt" FROM identity.session
        WHERE token_hash = sha256(convert_to($1, 'UTF8'))`,
      [token],
    )
  ).rows[0];

async function expectLive(token: string): Promise<void> {
  for (const id of SESSION_IDS)
    expect([id, (await call(id, token)).status]).toEqual([id, SESSION_ROUTES[id].live]);
}

async function expectSignedOut(answer: Response): Promise<void> {
  expect(answer.status).toBe(303);
  expect(answer.headers.getSetCookie()).toEqual([
    expect.stringMatching(/^__Host-ductus_session=;/u),
    // INT-20b: the short-lived sign-out mark that makes the next login ask again.
    "__Secure-ductus_signed_out=1; Path=/api/v1/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=300",
    // INT-20e: a login attempt started before the sign-out is dropped with it.
    "__Host-ductus_login=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
  ]);
}

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  await admin.query(`DROP ROLE IF EXISTS ${AUTH_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_auth', $1::text, $2::text) AS ddl",
    [AUTH_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  await admin.query(
    "INSERT INTO identity.institution (id, slug, aai_home_org) VALUES ($1, $2, $3)",
    [institution, `it-loc-${suffix}`, homeOrg],
  );
  await admin.query(
    "INSERT INTO identity.institution_issuer (institution_id, oidc_issuer) VALUES ($1, $2)",
    [institution, issuer],
  );
  const url = new URL(ADMIN_URL);
  url.username = AUTH_LOGIN;
  url.password = password;
  auth = new pg.Pool({ connectionString: url.href, max: 2 });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    // Step 8 lists every account with a confirmed second factor: the operator
    // list itself is tested in server/http (operator-policy-layer, SRV-1906).
    layers: createLayers({
      expectedOrigin: ORIGIN,
      operators: async () => "listed",
      secondFactor: async () => "confirmed",
      // The test sends one session token to every route twice (live, then old),
      // which is near the per-account limit of 300 a minute and grows with each
      // route; the limit is tested in server/http/rate-limit.integration.test.ts.
      rateLimiter: { check: () => ({ allowed: true, limitClass: "default" }) },
    }),
    databases,
    routes: MOUNTED,
  });
});

afterAll(async () => {
  await server?.close();
  await databases.close();
  await auth?.end();
  // The material kept through student.qual-materials.post refers to its owner.
  await admin.query("DELETE FROM institution.qual_material WHERE institution_id = $1", [
    institution,
  ]);
  // The live session of student.qual-codes.post made a code of its own: it refers to user_account too.
  await admin.query("DELETE FROM institution.qual_code WHERE institution_id = $1", [institution]);
  // user_preference and problem_report refer to user_account, so they go first.
  for (const table of [
    "user_preference",
    "problem_report",
    "person_name",
    "teacher_eligibility",
    "session",
    "user_account",
  ]) {
    await admin.query(`DELETE FROM identity.${table} WHERE institution_id = $1`, [institution]);
  }
  await admin.query("DELETE FROM identity.institution_issuer WHERE institution_id = $1", [
    institution,
  ]);
  await admin.query("DELETE FROM identity.institution WHERE id = $1", [institution]);
  await admin.query(`DROP ROLE IF EXISTS ${AUTH_LOGIN}`);
  await admin.end();
  vi.restoreAllMocks();
});

describe("the old session cookie after logout, over real PostgreSQL", () => {
  it("T5: the tested routes are every mounted route whose contract has a 401", () => {
    const entry = readFileSync(join(ROOT, "server/server.ts"), "utf8");
    const list = /\broutes:\s*\[([\s\S]*?)\n\s*\],/u.exec(entry)?.[1] ?? "";
    const code = list.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, "");
    expect([...code.matchAll(/\b(create\w+|routesOf)\(/gu)].map((m) => m[1])).toEqual(FACTORIES);
    // The server-to-server routes of Aplication_server read no cookie: their
    // 401 is a missing or wrong bearer token, so an old cookie cannot reach them.
    const internal = (r: (typeof MOUNTED)[number]) =>
      r.contract.path.startsWith(INTERNAL_PATH_PREFIX);
    expect(MOUNTED.filter(internal).map((r) => r.contract.id)).toEqual([
      "internal.institutions.post",
      "internal.institution.get",
    ]);
    const with401 = MOUNTED.filter(
      (r) => !internal(r) && r.contract.errors.some((e) => e.status === 401),
    );
    expect(with401.map((r) => r.contract.id).sort()).toEqual([...SESSION_IDS].sort());
  });

  it("T0, T1: live before logout, then 401 of each route's contract with the old cookie", async () => {
    const [token = ""] = await signIn(1);
    await expectLive(token);
    // A registration ceremony of this session, signed before logout and sent after it.
    const issued = await post("/api/v1/auth/webauthn/challenge", token, {
      purpose: "registration",
    });
    const { challenge } = (await issued.json()) as { challenge: string };
    const made = createSoftwareAuthenticator({
      rpId: new URL(ORIGIN).hostname,
      origin: ORIGIN,
    }).register(Buffer.from(challenge, "base64url"));
    const registration = {
      clientDataJSON: made.clientDataJSON.toString("base64url"),
      authenticatorData: made.authenticatorData.toString("base64url"),
      credentialId: made.credentialId.toString("base64url"),
    };
    await expectSignedOut(await post("/api/v1/auth/logout", token));
    expect(await sessionEnd(token)).toMatchObject({ reason: "logout" });
    expect(await savedLocale(token)).toEqual(["en"]);
    expect(await storedReports(token)).toBe(2);
    for (const id of SESSION_IDS) {
      const answer = await call(
        id,
        token,
        id === "profile.interface-locale.post"
          ? { locale: "hr" }
          : id === "auth.webauthn-registration.post"
            ? registration
            : undefined,
      );
      const body: unknown = await answer.json();
      const old =
        id.startsWith("settings.") ||
        id.startsWith("profile.") ||
        id === "support.problem-report.post" ||
        id === "support.problem-reports.post" ||
        id === "support.problem-reports.get" ||
        id === "support.problem-report-status.post" ||
        id === "sources.lookup.post" ||
        id === "course.aggregate.get" ||
        id.startsWith("analysis.") ||
        id.startsWith("institution.") ||
        id.startsWith("teacher.") ||
        id.startsWith("notifications.") ||
        id.startsWith("live.") ||
        id.startsWith("collaboration.") ||
        id.startsWith("projection.") ||
        id.startsWith("student.") ||
        id.startsWith("student-work.") ||
        id.startsWith("work.") ||
        id.startsWith("mentorship.") ||
        id.startsWith("practice.") ||
        id.startsWith("peer-review.") ||
        id.startsWith("auth.webauthn-")
          ? expect.objectContaining({ code: "unauthorized" })
          : id.startsWith("ops.")
            ? expect.objectContaining({ code: "unauthenticated" })
            : EVIDENCE_401;
      expect([id, answer.status, body]).toEqual([id, 401, old]);
      const spec = MOUNTED.find((r) => r.contract.id === id)?.contract.errors.find(
        (e) => e.status === 401,
      );
      expect(Value.Check(spec?.body as never, body)).toBe(true);
    }
    expect(await savedLocale(token)).toEqual(["en"]);
    // Only the two reports submitted with the live session were written.
    expect(await storedReports(token)).toBe(2);
  });

  it("the interface language: POST en, then GET en for the same session; another gets null", async () => {
    const [token = ""] = await signIn(1);
    const [other = ""] = await signIn(1);
    const saved = await post(LOCALE, token, { locale: "en" });
    expect([saved.status, await saved.json()]).toEqual([200, { locale: "en" }]);
    const read = await post(LOCALE, token, undefined, "GET");
    expect([read.status, await read.json()]).toEqual([200, { locale: "en" }]);
    const elsewhere = await post(LOCALE, other, undefined, "GET");
    expect([elsewhere.status, await elsewhere.json()]).toEqual([200, { locale: null }]);
    expect(await savedLocale(other)).toEqual([]);
  });

  it("T2, T4: logout again with the old cookie changes nothing; the other session lives", async () => {
    const [old = "", other = ""] = await signIn(2);
    await expectSignedOut(await post("/api/v1/auth/logout", old));
    const before = await sessionEnd(old);
    await expectSignedOut(await post("/api/v1/auth/logout", old));
    expect(await sessionEnd(old)).toEqual(before);
    expect(await sessionEnd(other)).toMatchObject({ closedAt: null });
    await expectLive(other);
  });

  it("T3: logout-all with the old cookie signs no other device out", async () => {
    const [old = "", other = ""] = await signIn(2);
    await expectSignedOut(await post("/api/v1/auth/logout", old));
    await expectSignedOut(await post("/api/v1/auth/logout-all", old));
    expect(await sessionEnd(old)).toMatchObject({ reason: "logout" });
    expect(await sessionEnd(other)).toMatchObject({ closedAt: null, reason: null });
    await expectLive(other);
  });
});

// The one entry point of the server (S-1B-a, DAN-775), built into
// dist/server.js by `pnpm build` (scripts/build). Read top to bottom it is the overview: the environment check, the
// databases, the layers, the areas whose routes are mounted, the start and the
// place for shutdown. It may import only http, settings and config
// (docs/server-map.md §2); it never opens a database connection itself.
import {
  appOrigin,
  environmentProblems,
  EXIT_CONFIGURATION,
  listenAddress,
  listenProblems,
  originProblems,
  SERVER_VERSION,
  shutdownGraceMs,
  shutdownProblems,
} from "./config/index.ts";
import {
  type AreaWithRoutes,
  createAccountRateLimiter,
  createAddressRateLimiter,
  createAuthRoutes,
  createClientContextRoute,
  createDownloadsManifestRoute,
  createWorkPdfRouteFor,
  createDatabases,
  createEvidenceCommitRouteFor,
  createInstitutionCourseRoutesFor,
  createInternalInstitutionRoutes,
  createMeRouteFor,
  createStaffAffiliationRouteFor,
  createStudentAssignmentWorkRouteFor,
  createStudentSubmissionRoutesFor,
  createReceiptPdfRoutesFor,
  createStudentNoticeRouteFor,
  createStudentConversationsRouteFor,
  createStudentAssignmentsRouteFor,
  createStudentMentoredAssignmentsRouteFor,
  createStudentAccessLogRouteFor,
  createStudentWriteRoutesFor,
  createStudentNotesRoutesFor,
  createTextCheckConfigRoute,
  createTeacherWorkRoutesFor,
  createOriginCompositionRoutesFor,
  createAssistantMatchRoutesFor,
  createInputRhythmRoutesFor,
  createRevisionRestoreRouteFor,
  createFacultyThresholdRoutesFor,
  createTeacherSourceRoutesFor,
  createTeacherWorkingCriteriaRoutesFor,
  createSourceProofRoutesFor,
  createWorkSourceRoutesFor,
  createSourceNotebookRoutesFor,
  createAttachmentRoutesFor,
  createWorkVersionsRouteFor,
  createWorkExportRouteFor,
  createSheetCsvRouteFor,
  createPortableRecordRouteFor,
  createSubmissionPackageRoutesFor,
  createTeacherSubmissionsBulkRoutesFor,
  createWorkVersionRouteFor,
  createWorkCompareRouteFor,
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
  createSourceLookupRouteFor,
  createPublicVerificationRouteFor,
  createTeacherReadRoutesFor,
  createTeacherSubmissionDetailRouteFor,
  createTeacherDeclarationRouteFor,
  createCourseAggregateRouteFor,
  createPilotMetricsRouteFor,
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
  createSubmissionWithdrawalRoutesFor,
  createStudentDeadlineHistoryRouteFor,
  createAssignmentCopyRouteFor,
  createMerlinRosterRoutesFor,
  createMerlinPackageRoutesFor,
  createAssistantRoutesFor,
  createStatementRoutesFor,
  createTeacherMentorshipRequestRoutesFor,
  createInstitutionAssignmentRoutesFor,
  createAssignmentCurrentVersionRouteFor,
  createEnrollmentCodeStateRouteFor,
  createAssignmentGradeRouteFor,
  excludePracticeAssignment,
  createInstitutionGroupRoutesFor,
  createAdminCourseRouteFor,
  createRosterImportRoutesFor,
  createInterfaceLocaleRoutesFor,
  createProblemReportRouteFor,
  createProblemReportsRouteFor,
  createLiveRoutesFor,
  createCollaborationCommentsRouteFor,
  createRevisionRequestsRouteFor,
  createCommentRoutesFor,
  createWorkMessagesRoutesFor,
  createMentorshipFollowRoutesFor,
  createSelfNoteSealedRoutesFor,
  createNotificationsRoutesFor,
  createDirectEditRoutesFor,
  createImportRoutesFor,
  createConsultationRecordRoutesFor,
  createEventDisputeRoutesFor,
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
  createAcknowledgmentRouteFor,
  createWebAuthnRoutesFor,
  createEvidenceOpenRoute,
  createEvidenceReplayRouteFor,
  createSubmissionRouteFor,
  createDeclarationRequiredRoutesFor,
  createDeclarationQuestionRoutesFor,
  createLateSubmissionRoutesFor,
  createCourseAssistantRoutesFor,
  createQualitativeMaterialsRoutesFor,
  createProcessSummaryRouteFor,
  createProcessSummaryDetailsRouteFor,
  createTeacherFastPathRouteFor,
  createSettingsReadRoutes,
  createSettingsValuesPutRoute,
  evidenceIngestDependencies,
  createLayers,
  createMetricsSampling,
  createShutdownCoordinator,
  createHealthRoute,
  createReadyRoute,
  createStatusRouteFor,
  installShutdown,
  logStartupFailed,
  logStartupRefused,
  facultyRulesProblems,
  parseTrustedProxies,
  readRateLimitConfig,
  readinessCheckFor,
  routesOf,
  serverShutdownHooks,
  startServer,
  trafficLogFor,
} from "./http/index.ts";
import {
  deploymentProblems,
  institutionsProblems,
  isNonProductionBuild,
  isStagingDeployment,
  kmsProblems,
  metricsIntervalMs,
  metricsIntervalProblems,
  testModeProblems,
} from "./settings/index.ts";

// 1. Environment. A bad value stops the start before anything listens; the
//    line names the variable, never its value. TRUSTED_PROXIES (addresses and
//    CIDR ranges) is optional; unset, X-Forwarded-For is never read. The
//    institutions file built into the server must pass its schema (DAN-911),
//    and so must every config/faculties/<faculty>/rules.json (SRV-1405).
//    DUCTURA_MODE=test never starts in production (S-1H.7, DAN-938-1). Any
//    DUCTUS_KMS_* variable asks for all three, usable (DAN-963).
const TRUSTED_PROXIES = parseTrustedProxies(process.env.TRUSTED_PROXIES);
const rateLimitConfig = readRateLimitConfig(process.env);
const problems = [
  ...environmentProblems(process.env),
  ...listenProblems(process.env),
  ...shutdownProblems(process.env),
  ...originProblems(process.env),
  ...metricsIntervalProblems(process.env),
  ...institutionsProblems(),
  ...facultyRulesProblems(),
  ...testModeProblems(process.env),
  ...deploymentProblems(process.env),
  ...rateLimitConfig.problems,
  ...kmsProblems(process.env),
  ...(TRUSTED_PROXIES === null
    ? ["TRUSTED_PROXIES is not a list of addresses and CIDR ranges"]
    : []),
];

// 2. Databases. Building the registry opens nothing: server/database connects
//    on first use, one pool per database (main, logs, legal; S-1F-a), so a
//    database that is down fails only its own calls.
// 3. Layers, in the order of docs/server-map.md §3, steps 2 to 8: client IP,
//    IP rules, rate limit, traffic record, security headers, origin check,
//    operator policy. The order is fixed in http (PIPELINE_STEPS); step 5 records
//    traffic (DAN-1536), step 4 limits requests (DAN-814), and without an
//    operator list and a second-factor port step 8 keeps operator paths closed
//    (DAN-842-1, DAN-1092-1). Without APP_ORIGIN every state-changing request gets 403.
// One origin for the pipeline's check and for WebAuthn's client data and rpId
// (DAN-840-3f1), so the two can never differ.
const APP_ORIGIN = appOrigin(process.env);
// Step 5 writes traffic.request through the log service into log_entry of the
// logs database (ductus_logs_writer, the pool of metricSamples); the service
// never throws and a request never waits for it (DAN-1536).
// Without LOGS_DATABASE_URL every record would fail and put a log_store_failed
// line on stderr, so traffic is recorded only where the logs database is set.
const logsConfigured = (env: NodeJS.ProcessEnv): boolean =>
  (env.LOGS_DATABASE_URL ?? "").trim() !== "";
const layersFor = (databases: ReturnType<typeof createDatabases>) =>
  createLayers({
    expectedOrigin: APP_ORIGIN,
    trustedProxies: TRUSTED_PROXIES ?? [],
    rateLimiter: createAddressRateLimiter(rateLimitConfig.limits),
    ...(logsConfigured(process.env) ? { trafficLog: trafficLogFor(databases.metricSamples) } : {}),
  });

// SRV-1401 (M1.6): CSP, Permissions-Policy and HSTS on every answer, HSTS
// only outside local work (NODE_ENV development or test, the one definition
// of production); idle sessions get 401 session_idle_expired after 30 minutes.
// STG-PRIJAVA (Ductus#2055): DUCTURA_DEPLOYMENT=staging on an APP_ORIGIN
// outside the production domain marks every answer X-Ductura-Deployment:
// staging and is announced at start; staging on a production origin or any
// other value is a startup problem above.
const STAGING = isStagingDeployment(process.env);
const SECURITY = { local: isNonProductionBuild(process.env.NODE_ENV), staging: STAGING };

// 4. Areas whose routes are mounted. Every server/<area>/routes.ts is named
//    here (server/server.test.ts); test-server mounts its own.
const AREAS: readonly AreaWithRoutes[] = [
  "traffic",
  "metrics",
  "settings",
  "roles",
  "legal",
  "backup",
  "deletion",
  "downloads",
  "external/email",
];

async function main(): Promise<void> {
  if (problems.length > 0) {
    // One structured line per problem (server/log), then EX_CONFIG (SRV-1812).
    logStartupRefused(problems);
    process.exitCode = EXIT_CONFIGURATION;
    return;
  }
  if (STAGING) {
    // A warning on every start, before anything listens: this process may
    // accept the fake OIDC provider and must never serve real students (D-09).
    console.warn(
      JSON.stringify({
        event: "server.staging",
        warning: "staging deployment: fake OIDC login may be enabled, never for real students",
      }),
    );
  }
  const { host, port } = listenAddress(process.env);
  const databases = createDatabases();
  const reminderCooldown = process.env.DUCTURA_NOTIFICATION_REMINDER_INTERVAL_SECONDS;
  const limitAccount = createAccountRateLimiter(rateLimitConfig.limits, databases.main.actorReader);
  // One signer and one storage per process, shared by commit and replay.
  const evidenceDeps = evidenceIngestDependencies(process.env, process.cwd());
  const checkReadiness = readinessCheckFor(databases.main, evidenceDeps);
  const shutdown = createShutdownCoordinator({ graceMs: shutdownGraceMs(process.env) });
  const draining = () => shutdown.state() !== "running";
  const options = {
    host,
    port,
    databases,
    shutdown,
    layers: layersFor(databases),
    security: SECURITY,
    routes: [
      createHealthRoute({ health: databases.health, serverVersion: SERVER_VERSION }),
      // Readiness (SRV-1812, M11.3): 503 until the main database answers and
      // its migrations are done; storage and signing are reported. Draining
      // answers 503 too, so a balancer stops sending before the listener closes.
      createReadyRoute({ check: checkReadiness, draining }),
      createStatusRouteFor(databases.main, checkReadiness, draining),
      // The preloader's environment (S-1M-b, D-300); no log writer is wired
      // into the process yet, so it is checked and answered, not recorded.
      createClientContextRoute(),
      createEvidenceOpenRoute(databases.main),
      createStudentAssignmentWorkRouteFor(databases.main),
      ...createStudentNotesRoutesFor(databases.main),
      ...createWorkSourceRoutesFor(databases.main),
      ...createSourceNotebookRoutesFor(databases.main),
      ...createSourceProofRoutesFor(databases.main),
      createTextCheckConfigRoute(databases.main),
      // The teacher's read of one work by its document id (SRV-2003).
      ...createTeacherWorkRoutesFor(databases.main),
      // The composition of a work by the kind of origin (SRV-0910, P-1).
      ...createOriginCompositionRoutesFor(databases.main),
      // The match of a segment with the answers of the assistant (SRV-1230, P-1 rule 13).
      ...createAssistantMatchRoutesFor(databases.main),
      // The rhythm of typing and the teacher's switch of it (PIL-P1-RITAM-SRV, P-1 rule 4).
      ...createInputRhythmRoutesFor(databases.main),
      createRevisionRestoreRouteFor(databases.main),
      // The thresholds of a faculty per kind of origin and the comparison of a work (SRV-1111, P-1).
      ...createFacultyThresholdRoutesFor(databases.main),
      // The guidance of a teacher on sources (SRV-1605, WEB-2133).
      ...createTeacherSourceRoutesFor(databases.main),
      // The teacher's private working criteria of a work (SRV-1107, B-9).
      ...createTeacherWorkingCriteriaRoutesFor(databases.main),
      createSourceLookupRouteFor(databases.main, process.env),
      // The public check of a receipt (SRV-9B, C-6): no session read or issued (D-09).
      createPublicVerificationRouteFor(databases.main),
      // The desktop packages over the release configuration built in (S-1H.5-b, DAN-932).
      createDownloadsManifestRoute(),
      // Settings by level (S-1J-g, DAN-826; SRV-7E).
      createSettingsValuesPutRoute({ writer: databases.main.settingsWriter }),
      ...createSettingsReadRoutes(databases.main),
      // The interface language (S-M-1, DAN-851): GET and POST over the profile service.
      ...createInterfaceLocaleRoutesFor(databases.main),
      // The problem report (S-M-2, DAN-851): POST over the support service.
      createProblemReportRouteFor(databases.main),
      createProblemReportsRouteFor(databases.main),
      // Courses of an institution, the enrolment code and its revocation (S-M-2a, DAN-852).
      ...createInstitutionCourseRoutesFor(databases.main),
      // Whether the course has a current enrolment code (Ductus#2028 c.7019844365).
      createEnrollmentCodeStateRouteFor(databases.main),
      // A course's new assignment and an assignment's next version (SRV-14, Ductus#2028).
      ...createInstitutionAssignmentRoutesFor(databases.main),
      createAssignmentCurrentVersionRouteFor(databases.main),
      createAssignmentGradeRouteFor(databases.main),
      // A course's seminar groups and their teachers (SRV-15, Ductus#2028).
      ...createInstitutionGroupRoutesFor(databases.main),
      // The administrator creates a course with its holder (SRV-12 over SRV-07, Ductus#2028).
      createAdminCourseRouteFor(databases.main),
      // The administrator imports a course's students from Merlin or ISVU in two steps (SRV-ADMIN-2, NF-7 OA-10).
      ...createRosterImportRoutesFor(databases.main),
      // The live view (B-LIVE): the owner publishes the last state of a work
      // with PUT, every reader gets the same bytes and ETag with GET.
      ...createLiveRoutesFor(databases.main),
      createCollaborationCommentsRouteFor(databases.main),
      // SRV-2006: revision requests (DAN-314), the teacher asks for a rework of a passage.
      createRevisionRequestsRouteFor(databases.main),
      // SRV-1106: the short messages next to a work, one conversation for its student and teachers.
      ...createWorkMessagesRoutesFor(databases.main),
      // SRV-MENTOR-3: note to self and reading place (MK-9), seen marks (MK-11), the mentor's overview (MK-8).
      ...createMentorshipFollowRoutesFor(databases.main),
      // SRV-NF6-SIFRA: the note to self sealed on the device and the wrapped note key (B2).
      ...createSelfNoteSealedRoutesFor(databases.main),
      ...createNotificationsRoutesFor(databases.main, reminderCooldown),
      // SRV-1703: delayed comments (D-51), the comment bank (N-03) and the changes since the last review (N-05).
      ...createCommentRoutesFor(databases.main, evidenceDeps),
      // SRV-1702: the direct-edit setting of a work; the teacher's edit goes through the live put.
      ...createDirectEditRoutesFor(databases.main),
      // SRV-1803: a DOCX import into a work and its idempotent confirmation.
      ...createImportRoutesFor(databases.main),
      ...createConsultationRecordRoutesFor(databases.main),
      // SRV-1315: amendments and disputes of process summary events of a work.
      ...createEventDisputeRoutesFor(databases.main),
      ...createWorkMilestonesRoutesFor(databases.main),
      ...createMilestoneTemplateRoutesFor(databases.main),
      // SRV-V17-RUBRIC-DEF: the rubric of an assignment (teacher defines, student reads).
      ...createAssignmentRubricRoutesFor(databases.main),
      // SRV-V21-KOD-TESTOVI-RUTA: the code tests of an assignment (teacher writes, both read).
      ...createAssignmentCodeTestsRoutesFor(databases.main),
      // SRV-V18-UPITNIK-AUTOR: the questionnaires of a course (teacher makes, edits a draft, opens, closes).
      ...createQuestionnaireRoutesFor(databases.main),
      // SRV-V17-RUBRIC-LEVEL: the teacher's mark of a level per rubric criterion on a work.
      ...createWorkRubricRoutesFor(databases.main),
      // SRV-V17-TEMPLATE-ADMIN: the work template of the institution per work type.
      ...createWorkTemplateRoutesFor(databases.main),
      // SRV-V17-TEMPLATE-ASSIGN: the work template frozen on an assignment.
      ...createAssignmentTemplateRoutesFor(databases.main),
      // SRV-V17-FORMAT-RULES: the format rules of an assignment for the check before submission.
      ...createFormatRulesRoutesFor(databases.main),
      // SRV-1606: the teacher returns the whole submitted work for revision.
      ...createReturnForRevisionRoutesFor(databases.main),
      // The student acknowledges the assignment notice shown by the browser (DAN-306).
      createAcknowledgmentRouteFor(databases.main),
      // WebAuthn as the second factor of operators, never a way to sign in (S-1E-g, DAN-840; D-09).
      ...createWebAuthnRoutesFor(databases.main, APP_ORIGIN),
      // B-8: the development signer only under NODE_ENV development or test;
      // storage only from EVIDENCE_STORAGE_DOMAINS (503 otherwise); protocol 2
      // only under DUCTUS_EVIDENCE_ASYNC_SIGNING=1 (DAN-821-3).
      createEvidenceCommitRouteFor(databases.main, evidenceDeps),
      // DAN-818: one replay page, read from the same storage as commit writes.
      createEvidenceReplayRouteFor(databases.main, evidenceDeps),
      // SRV-9A: the versions of a work, the same page for its owner and its teacher.
      createWorkVersionsRouteFor(databases.main),
      // SRV-1310: the DOCX of a saved version of a work, rendered from its export snapshot.
      createWorkExportRouteFor(databases.main),
      // SRV-V14-SHEET-CSV: the CSV of one sheet of a spreadsheet work, the same readers as the DOCX.
      createSheetCsvRouteFor(databases.main),
      // SRV-1312: the portable record of the student's own submission, a checked deterministic ZIP.
      createPortableRecordRouteFor(databases.main, APP_ORIGIN),
      // SRV-1807: the 24 hour link to the export package and the confirmation for the registrar.
      ...createSubmissionPackageRoutesFor(databases.main, APP_ORIGIN),
      excludePracticeAssignment(
        createWorkPdfRouteFor(databases.main, process.env.DUCTURA_PDF_RENDERER_ORIGIN),
        databases.main,
      ),
      createWorkVersionRouteFor(databases.main, evidenceDeps),
      // SRV-2004: the comparison of two revisions of a work, rebuilt from the record.
      createWorkCompareRouteFor(databases.main, evidenceDeps),
      ...createConsultationSlotRoutesFor(databases.main),
      // SRV-1530: the interview preparation of a work (N-14).
      ...createWorkInterviewRoutesFor(databases.main),
      // SRV-1531: the same preparation as a PDF.
      createWorkInterviewPdfRouteFor(databases.main),
      // SRV-1407: the moves of one mentorship request (D-204).
      ...createMentorshipRequestRoutesFor(databases.main),
      // SRV-1414: the student's own requests and the teachers they may ask.
      ...createMentorshipStudentRoutesFor(databases.main),
      // SRV-MENTOR-1: opening a mentorship, slot details and moves, agreed tasks (NF-6).
      ...createMentorshipConsultationRoutesFor(databases.main),
      // SRV-1412: the student starts the own work and reads the own works.
      ...createStudentWorkRoutesFor(databases.main),
      ...createKeyDatesRoutesFor(databases.main),
      ...createTeachingTeamRoutesFor(databases.main),
      ...createMentorNotesRoutesFor(databases.main),
      ...createPracticeJournalRoutesFor(databases.main),
      ...createWorkTeamRoutesFor(databases.main),
      ...createPeerReviewRoutesFor(databases.main),
      // SRV-V18-KODIRANJE-SIFRARNIK: the codebook of a student's own qualitative coding.
      ...createQualitativeCodesRoutesFor(databases.main),
      // SRV-MENTOR-2: thesis forms, the mentor's consent and the stage after submission.
      ...createThesisRoutesFor(databases.main),
      // SRV-V16-TEMA-PRIJEDLOG: the student proposes the topic of a thesis, the mentor decides.
      ...createThesisTopicRoutesFor(databases.main),
      // SRV-V16-POVJERENSTVO-ZAPIS: the committee of a thesis as a list, named by the administrator.
      ...createThesisCommitteeRoutesFor(databases.main),
      // SRV-V16-POPIS-FAKULTET: the theses of the faculty for the registrar, read only.
      ...createThesisOverviewRoutesFor(databases.main),
      ...createAttachmentRoutesFor(databases.main, process.env, process.cwd()),
      // B-12 step 4b2 (SRV-18): a student's submission, over the same signer and
      // storage as commit; the time is the database's, never the client's.
      createSubmissionRouteFor(databases.main, evidenceDeps),
      // PIL-K-IZJAVA-SRV: the second major, with 409 declaration_required, and the teacher's switch.
      createSubmissionRouteFor(databases.main, evidenceDeps, 2),
      ...createDeclarationRequiredRoutesFor(databases.main),
      // SRV-IZJAVA-PITANJE: the teacher's optional question with the declaration.
      ...createDeclarationQuestionRoutesFor(databases.main),
      // SRV-NF4-KASNA-POLJE: whether a submission after the deadline is allowed.
      ...createLateSubmissionRoutesFor(databases.main),
      // SRV-ASIST-PREKIDAC: the assistant switch per course and its availability.
      ...createCourseAssistantRoutesFor(databases.main),
      // SRV-V18-KODIRANJE-GRADIVO: the student's own material for qualitative coding.
      ...createQualitativeMaterialsRoutesFor(databases.main),
      // B-13 step 3 (SRV-23): the process summary of one work, the same bytes for
      // its owner and the teacher; the teacher's read writes the access log.
      createProcessSummaryRouteFor(databases.main, evidenceDeps, process.env),
      createProcessSummaryDetailsRouteFor(databases.main, evidenceDeps, process.env),
      // N-05 (SRV-8E): the teacher's fast path through the works of one assignment,
      // over the same storage and thresholds as the process summary.
      createTeacherFastPathRouteFor(databases.main, evidenceDeps, process.env),
      // SRV-22: the student's own submission state and word range of one
      // assignment, the receipt byte for byte as the submission bound it.
      ...createStudentSubmissionRoutesFor(databases.main),
      // SRV-9C, INT-31: the PDF of the receipt, for the student and for the
      // teacher, its verification link on the same origin as the pipeline.
      ...createReceiptPdfRoutesFor(databases.main, APP_ORIGIN),
      // SRV-NG: the notice of the current version for a student of the course (E-6).
      createStudentNoticeRouteFor(databases.main),
      // Faza 3 readiness: the student's assignment list (DAN-803), own access log
      // (DAN-904), enrolment by code and notice read (SRV-02), over the main database.
      createStudentAssignmentsRouteFor(databases.main),
      // INT-31: the assignments of the student's open mentorships (a thesis has no course).
      createStudentMentoredAssignmentsRouteFor(databases.main),
      createStudentAccessLogRouteFor(databases.main),
      ...createStudentWriteRoutesFor(databases.main),
      // The signed-in account for the front of the institution (Ductus#2028 c.6993786629 §3.3).
      createMeRouteFor(databases.main),
      // SRV-1403: the caller's own staff affiliation, or staff_affiliation_missing.
      createStaffAffiliationRouteFor(databases.main),
      // The teacher's courses and access for the teacher shell (SRV-13, Ductus#2028).
      ...createTeacherReadRoutesFor(databases.main),
      createTeacherSubmissionDetailRouteFor(databases.main),
      createTeacherDeclarationRouteFor(databases.main),
      createCourseAggregateRouteFor(databases.main),
      // SRV-1906 (plan P-D6): the operator's pilot numbers, behind step 8.
      createPilotMetricsRouteFor(databases.main),
      // SRV-ADMIN-1 (NF-7 OA-7, OA-3): problem reports routed by kind and their
      // state; the administrator's log of administrator and operator actions.
      ...createProblemReportInboxRoutesFor(databases.main),
      createAdminActionLogRouteFor(databases.main),
      // SRV-1304 (plan M10.2, M10.7): the administrator's retention dry run.
      createRetentionRouteFor(databases.main),
      // SRV-1406: the versioned rules of the institution, for its administrator.
      // SRV-2001: faculty rules of the institution, read and published by its administrator.
      ...createFacultyRuleRoutesFor(databases.main),
      // SRV-ADMIN-3 (NF-7 OA-9): the faculty's assistant setting, read only, for its administrator.
      createAssistantSettingRouteFor(databases.main),
      ...createInstitutionConfigRoutesFor(databases.main),
      // SRV-1706 (plan M10.4): who opened the student's own work, in days.
      createWorkAccessRouteFor(databases.main),
      ...createTeacherRosterRoutesFor(databases.main),
      ...createInstitutionReadRoutesFor(databases.main),
      // SRV-1108: the deadline extensions of an assignment for its teacher.
      ...createDeadlineExtensionRoutesFor(databases.main),
      // SRV-1306 (plan M10.3): legal holds of the institution, for its administrators.
      ...createLegalHoldRoutesFor(databases.main),
      ...createStudentDataExportRoutesFor(databases.main, process.env, process.cwd()),
      createStudentDeadlineHistoryRouteFor(databases.main),
      // SRV-1903: withdrawal of a submission, the history and the teacher's switch,
      // signed with the same signer as the submission receipt.
      ...createSubmissionWithdrawalRoutesFor(databases.main, evidenceDeps),
      // SRV-1904 (P-D4): the teacher copies an assignment into a course they teach.
      createAssignmentCopyRouteFor(databases.main),
      // SRV-1109: the Merlin roster of an assignment and its CSV, for its teacher.
      ...createMerlinRosterRoutesFor(databases.main).map((route) =>
        excludePracticeAssignment(route, databases.main),
      ),
      // SRV-1110: the Merlin package of an assignment and its download, for its teacher.
      ...createMerlinPackageRoutesFor(databases.main),
      // SRV-1902 (P-D2): the 24 hour link to the ZIP of all submissions of an assignment, for its teacher.
      ...createTeacherSubmissionsBulkRoutesFor(databases.main, APP_ORIGIN).map((route) =>
        excludePracticeAssignment(route, databases.main),
      ),
      // SRV-1204: the AI assistant proxy; no provider in production, so ai_disabled.
      ...createAssistantRoutesFor(databases.main),
      // SRV-ASIST-CITANJE: the student's own assistant conversations of an assignment.
      createStudentConversationsRouteFor(databases.main),
      ...createStatementRoutesFor(databases.main),
      ...createTeacherMentorshipRequestRoutesFor(databases.main),
      // Provisioning of an institution instance by Aplication_server, server
      // to server (§2): 404 unless DUCTURA_PROVISIONING_TOKEN is set.
      ...createInternalInstitutionRoutes({ env: process.env }),
      // Login over AAI@EduHr (S-1E-a; D-09: the fake provider only in development and test).
      ...createAuthRoutes(process.env),
      ...routesOf(AREAS),
    ],
  };
  const running = await startServer({ ...options, routes: limitAccount(options.routes) }).catch(
    (error: unknown) => {
      // A system error has a code (EADDRINUSE, EACCES); anything else is a
      // programming error of the route table, whose message names no value.
      logStartupFailed(error);
      process.exitCode = 1;
      return undefined;
    },
  );
  if (running === undefined) return;

  // Metrics (S-1K.4-b, DAN-834-5a): every METRICS_INTERVAL_MS one round of
  // database_connections into metric_sample of the logs database; a failing
  // round is skipped and logged by its reason, never stopping the server.
  const metrics = createMetricsSampling({
    intervalMs: metricsIntervalMs(process.env),
    health: databases.health,
    store: databases.metricSamples,
  });
  metrics.start();

  // 5. Shutdown (S-1B-c). The first SIGTERM or SIGINT: stop accepting, finish
  //    the started requests, stop metrics (waiting for the round in progress),
  //    flush the logs, close the databases, exit 0;
  //    whatever is left at the deadline exits 1 (server/http/shutdown.ts).
  type Signal = "SIGTERM" | "SIGINT";
  const signals = {
    on: (signal: Signal, listener: () => void) => process.on(signal, listener),
    off: (signal: Signal, listener: () => void) => process.off(signal, listener),
  };
  installShutdown(signals, {
    coordinator: shutdown,
    listener: running,
    hooks: serverShutdownHooks({ metrics, databases }),
    exit: (code) => process.exit(code),
  });
  // Announced only once the signals are handled: a SIGTERM sent on this line
  // must reach installShutdown, not the default action that kills the process.
  console.log(JSON.stringify({ event: "server.listening", host, port: running.port }));
}

await main();

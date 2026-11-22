// The dev fake server (Ductus#2028): every route of /api/v1 from the contract,
// with in-memory state, for building the web without the server's handlers.
// Local development and tests only (D-09): loading it elsewhere throws.
import "../guard/index.ts";

import type { Operations } from "../../contracts/index.ts";
import { ACCOUNT_HANDLERS } from "./account-routes.ts";
import { ASSISTANT_HANDLERS } from "./assistant-routes.ts";
import { STATEMENT_HANDLERS } from "./statement-routes.ts";
import { ATTACHMENT_HANDLERS } from "./attachment-routes.ts";
import { COLLABORATION_HANDLERS } from "./collaboration-routes.ts";
import { CONSULTATION_SLOT_HANDLERS } from "./consultation-slots.ts";
import { MENTORSHIP_REQUEST_HANDLERS } from "./mentorship-requests.ts";
import { KEY_DATES_HANDLERS } from "./key-dates.ts";
import { TEACHING_TEAM_HANDLERS } from "./teaching-team-routes.ts";
import { successBody } from "./contract.ts";
import { EVIDENCE_HANDLERS } from "./evidence-routes.ts";
import { COURSE_SETUP_HANDLERS } from "./course-setup-routes.ts";
import { INSTITUTION_HANDLERS } from "./institution-routes.ts";
import { SETTINGS_HANDLERS } from "./settings-routes.ts";
import { STUDENT_HANDLERS } from "./student-routes.ts";
import { STUDENT_WORK_HANDLERS } from "./student-work-routes.ts";
import { SOURCE_NOTE_HANDLERS } from "./source-notebook-routes.ts";
import { TEACHER_HANDLERS } from "./teacher-routes.ts";
import { COMMENTS_HANDLERS } from "./comments-routes.ts";
import { MESSAGES_HANDLERS } from "./messages-routes.ts";
import { NOTIFICATION_HANDLERS } from "./notification-routes.ts";
import { DIRECT_EDIT_HANDLERS } from "./direct-edit-routes.ts";
import { IMPORT_HANDLERS } from "./import-routes.ts";
import { ASSIGNMENT_COPY_HANDLERS } from "./assignment-copy-routes.ts";
import { CONSULTATION_HANDLERS } from "./consultation-routes.ts";
import { EVENT_DISPUTE_HANDLERS } from "./event-dispute-routes.ts";
import { MILESTONE_HANDLERS } from "./milestone-routes.ts";
import { SUBMISSION_WITHDRAWAL_HANDLERS } from "./submission-withdrawal-routes.ts";
import { OPS_HANDLERS } from "./ops-routes.ts";
import { RETENTION_HANDLERS } from "./retention-routes.ts";
import { LEGAL_HOLD_HANDLERS } from "./legal-hold-routes.ts";
import { STUDENT_DATA_EXPORT_HANDLERS } from "./student-data-export-routes.ts";
import { FACULTY_RULE_HANDLERS } from "./faculty-rule-routes.ts";
import { INSTITUTION_CONFIG_HANDLERS } from "./institution-config-routes.ts";
import { ACCESS_LOG_HANDLERS } from "./access-log-routes.ts";
import { MENTOR_NOTES_HANDLERS } from "./mentor-notes.ts";
import { VERSIONS_HANDLERS } from "./versions-routes.ts";
import { WORK_EXPORT_HANDLERS } from "./work-export-routes.ts";
import { PORTABLE_RECORD_HANDLERS } from "./portable-record-routes.ts";
import { SUBMISSION_PACKAGE_HANDLERS } from "./submission-package-routes.ts";
import { SUBMISSIONS_BULK_HANDLERS } from "./submissions-bulk-routes.ts";
import type { Handlers } from "./server.ts";

type SourceLookupBody = Operations["sources.lookup.post"]["success"]["body"];
type PublicVerificationBody = Operations["public.verification.post"]["success"]["body"];

export {
  answerDev,
  createDevServer,
  DELAY_HEADER,
  DELAY_PARAM,
  ERROR_HEADER,
  ERROR_PARAM,
  MAX_DELAY_MS,
  SESSION_COOKIE,
  type Context,
  type DevRequest,
  type Handlers,
  type Reply,
} from "./server.ts";
export { DEFAULT_PORT, devServerPort } from "./port.ts";
export {
  ACCOUNT_KEYS,
  CODES,
  createState,
  EMPTY_DOCUMENT,
  IDS,
  INSTITUTION,
  type AccountKey,
  type State,
} from "./state.ts";

/**
 * The answer of every route of the contract, by operation id.
 * coverage.test.ts fails for a route of ROUTE_TABLE without one.
 */
export const DEV_HANDLERS: Handlers = {
  ...ATTACHMENT_HANDLERS,
  ...ACCOUNT_HANDLERS,
  ...INSTITUTION_HANDLERS,
  ...COURSE_SETUP_HANDLERS,
  ...STUDENT_HANDLERS,
  ...STUDENT_WORK_HANDLERS,
  ...SOURCE_NOTE_HANDLERS,
  ...TEACHER_HANDLERS,
  ...SETTINGS_HANDLERS,
  ...EVIDENCE_HANDLERS,
  ...COLLABORATION_HANDLERS,
  ...CONSULTATION_SLOT_HANDLERS,
  ...MENTORSHIP_REQUEST_HANDLERS,
  ...KEY_DATES_HANDLERS,
  ...TEACHING_TEAM_HANDLERS,
  ...MENTOR_NOTES_HANDLERS,
  ...ASSISTANT_HANDLERS,
  ...STATEMENT_HANDLERS,
  ...VERSIONS_HANDLERS,
  ...WORK_EXPORT_HANDLERS,
  ...PORTABLE_RECORD_HANDLERS,
  ...SUBMISSION_PACKAGE_HANDLERS,
  ...SUBMISSIONS_BULK_HANDLERS,
  ...MESSAGES_HANDLERS,
  ...NOTIFICATION_HANDLERS,
  ...COMMENTS_HANDLERS,
  ...DIRECT_EDIT_HANDLERS,
  ...IMPORT_HANDLERS,
  ...ASSIGNMENT_COPY_HANDLERS,
  ...CONSULTATION_HANDLERS,
  ...EVENT_DISPUTE_HANDLERS,
  ...MILESTONE_HANDLERS,
  ...SUBMISSION_WITHDRAWAL_HANDLERS,
  ...OPS_HANDLERS,
  ...RETENTION_HANDLERS,
  ...LEGAL_HOLD_HANDLERS,
  ...STUDENT_DATA_EXPORT_HANDLERS,
  ...FACULTY_RULE_HANDLERS,
  ...INSTITUTION_CONFIG_HANDLERS,
  ...ACCESS_LOG_HANDLERS,
  "work.export-pdf.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find(
      (item) => item.assignmentId === params.assignmentId && item.documentId === params.documentId,
    );
    if (work === undefined) return { error: "not_found" };
    const mentorsWork =
      account.roles.includes("teacher") &&
      state.mentorships.some(
        (item) =>
          item.assignmentId === work.assignmentId &&
          item.documentId === work.documentId &&
          item.mentorId === account.id,
      );
    if (work.studentId !== account.id && !mentorsWork) return { error: "not_found" };
    return {
      status: 200,
      body: successBody(
        "work.export-pdf.get",
      ) as Operations["work.export-pdf.get"]["success"]["body"],
    };
  },
  "sources.lookup.post": ({ account, body }) => {
    if (!account?.roles.includes("student")) return { error: "forbidden" };
    const match =
      body.kind === "doi" && body.identifier.trim().toLowerCase() === "10.99999/izmisljeni";
    const result = match
      ? (successBody("sources.lookup.post") as SourceLookupBody)
      : { source: null };
    return { status: 200, body: result };
  },
  // SRV-9B (C-6): only the invented pair of the contract's "match" vector matches.
  "public.verification.post": ({ body }) => {
    const known = successBody("public.verification.post") as PublicVerificationBody;
    const match =
      body.submissionId === "00000000-0000-4000-8000-00000000c0de" &&
      body.artifactSha256 === "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
    return { status: 200, body: match ? known : { match: false } };
  },
};

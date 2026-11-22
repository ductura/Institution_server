import { createHash } from "node:crypto";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { IMPORT_READ_LIMITS } from "../../../server/contracts/index.ts";
import { prepareDocxImport } from "../../../server/import/index.ts";

import { ROUTE_TABLE } from "../fake-server/index.ts";
import { errorCodes, type RouteId } from "./contract.ts";
import {
  createState,
  DEV_HANDLERS,
  EMPTY_DOCUMENT,
  IDS,
  type AccountKey,
  type State,
} from "./index.ts";
import { fakeImportIds } from "./import-routes.ts";
import { studentDataExportTokenHashOf } from "./student-data-export-routes.ts";
import { bulkTokenFor } from "./submissions-bulk-routes.ts";
import { contractProblems, evidenceSegment, send, signIn, type Sent } from "./testing.ts";

// Every route of the contract answers on the dev fake server, and the answer
// fits the contract. A route added to ROUTE_TABLE without a handler or without
// a scenario here fails this file.

type Step = Sent & { readonly path: string; readonly as?: AccountKey };
type Scenario = {
  readonly before?: readonly Step[];
  readonly prepare?: (state: State) => void;
  readonly request: Step;
};

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const EVIDENCE = { ...ORIGIN, "ductus-protocol": "1" };
const SEGMENT = evidenceSegment(createState());
const commit = (txid: string, baseRevision: number): Step => ({
  path: "/api/v1/evidence/commit",
  as: "student",
  headers: EVIDENCE,
  body: {
    documentId: IDS.document,
    clientTransactionId: txid,
    baseRevision,
    segments: [SEGMENT],
    document: EMPTY_DOCUMENT,
  },
});
const CREATE_CONSULTATION: Step = {
  path: `/api/v1/works/${IDS.document}/consultation-records`,
  as: "nastavnik",
  headers: ORIGIN,
  body: {
    heldOn: "2026-11-18",
    revision: 1,
    topic: "Izmišljena struktura rada",
    agreement: "Dodati zaključak.",
  },
};
const CREATE_EVENT_DISPUTE: Step = {
  path: `/api/v1/works/${IDS.document}/event-disputes`,
  as: "student",
  headers: ORIGIN,
  body: { kind: "dispute", eventId: "pastes/0", text: "Izmišljeno osporavanje opisa." },
};
const ANCHOR = {
  nodeId: "0a000000-0000-4000-8000-000000000001",
  quote: "Izmišljeno",
  prefix: "",
  suffix: "",
  startHint: 0,
  endHint: 10,
};
const LIVE = { nodes: [], schemaVersion: 1 };
const livePut: Step = {
  path: `/api/v1/live/${IDS.document}`,
  as: "student",
  method: "PUT",
  headers: { ...ORIGIN, "if-none-match": "*" },
  body: LIVE,
};
const createRequest: Step = {
  path: "/api/v1/revision-requests/create",
  as: "nastavnik",
  headers: ORIGIN,
  body: {
    anchor: ANCHOR,
    documentId: IDS.document,
    instruction: "Izmišljena uputa.",
    requestedRevision: 0,
  },
};
const SETTING = {
  level: "personal",
  course: null,
  key: "notifications.email",
  value: false,
  locked: false,
  min: null,
  max: null,
};
const REPORT = {
  appVersion: "1.4.0",
  browser: { family: "firefox", major: 140 },
  category: "technical",
  description: "Izmišljeni opis.",
  route: null,
  syncState: null,
};
const VERSION = {
  expectedVersion: 1,
  title: "Izmišljeni naslov",
  instructions: "Izmišljene upute.",
  workType: "seminar_paper",
  opensAt: "2026-10-01T06:00:00Z",
  dueAt: "2027-01-31T22:59:00Z",
  aiPolicy: "partially_allowed",
  aiPurposes: ["proofreading"],
  evidenceProfile: "basic",
  importAllowed: false,
  wordMin: 1500,
  wordMax: 2500,
};
const A = `/api/v1/institution/assignments/${IDS.assignment}`;
// SRV-1803: an invented DOCX, its import into the demo work and the preview's hash.
const DOCX_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const DOCX_BASE64 = Buffer.from(
  zipSync({
    "[Content_Types].xml": strToU8(
      `${DOCX_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    ),
    "_rels/.rels": strToU8(
      `${DOCX_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    ),
    "word/document.xml": strToU8(
      `${DOCX_HEAD}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Izmišljeni uvezeni odlomak.</w:t></w:r></w:p></w:body></w:document>`,
    ),
  }),
).toString("base64");
const IMPORTS = `/api/v1/works/${IDS.document}/imports`;
const POST_IMPORT: Step = {
  path: IMPORTS,
  as: "student",
  headers: ORIGIN,
  body: { fileBase64: DOCX_BASE64, fileName: "Seminar.docx" },
};
const FIRST_IMPORT = (() => {
  const ids = fakeImportIds(1);
  const prepared = prepareDocxImport({
    bytes: new Uint8Array(Buffer.from(DOCX_BASE64, "base64")),
    documentId: IDS.document,
    fileName: "Seminar.docx",
    limits: IMPORT_READ_LIMITS,
    importId: ids.importId,
    uuid: ids.uuid,
  });
  if (!prepared.ok) throw new Error("the invented DOCX must read");
  return { importId: ids.importId, manifestSha256: prepared.preview.manifestSha256 };
})();
const C = `/api/v1/institution/courses/${IDS.course}`;
const TEAM = `/api/v1/courses/${IDS.course}/team`;
const SET_TEAM: Step = {
  path: TEAM,
  as: "nastavnik",
  headers: ORIGIN,
  body: { assistantIds: [IDS.teacher2] },
};
const STUDENT_ASSIGNMENT = `/api/v1/student/assignments/${IDS.assignment}`;
const CONSULTATION_SLOTS = `/api/v1/works/${IDS.document}/consultation-slots`;
const REQUEST_SLOT: Step = {
  path: CONSULTATION_SLOTS,
  as: "student",
  headers: ORIGIN,
  body: { startsAt: new Date(Date.now() + 86_400_000).toISOString() },
};
const INTERVIEW = `/api/v1/works/${IDS.document}/interview`;
const INTERVIEW_QUESTION_ID = "c0300000-0000-4000-8000-000000000001";
const ADD_QUESTION: Step = {
  path: `${INTERVIEW}/questions`,
  as: "nastavnik",
  headers: ORIGIN,
  body: { paragraphRef: "odlomak-1", questionText: "Kako je nastao ovaj odlomak?" },
};
const INVITE: Step = { path: `${INTERVIEW}/invite`, as: "nastavnik", headers: ORIGIN };
const NOTE: Step = {
  path: "/api/v1/student/submission-notes",
  as: "student",
  headers: ORIGIN,
  body: { assignmentId: IDS.assignment, text: "Izmišljena napomena." },
};

const WORK_SOURCE = {
  id: "00000000-0000-4000-8000-00000000c0a1",
  type: "book",
  authors: [{ kind: "person", family: "Izmišljeni", given: "Autor" }],
  year: 2019,
  title: "Izmišljena knjiga o kućnom kompostiranju",
  place: "Izmišljeni grad",
  publisher: "Izmišljena naklada",
};

const SAVE_SOURCE: Step = {
  path: `${STUDENT_ASSIGNMENT}/sources/${WORK_SOURCE.id}`,
  as: "student",
  method: "PUT",
  headers: ORIGIN,
  body: { record: WORK_SOURCE },
};
const SOURCE_NOTES = `/api/v1/works/${IDS.document}/sources/${WORK_SOURCE.id}/notes`;
const NOTE_ID = "00000000-0000-4000-8000-00000000b001";
const ADD_NOTE: Step = {
  path: SOURCE_NOTES,
  as: "student",
  method: "POST",
  headers: ORIGIN,
  body: { note: "Izmišljena bilješka." },
};
const seedNote = (state: State) => {
  state.sourceNotes.set(`${IDS.assignment}:${IDS.student}:${WORK_SOURCE.id}`, [
    { id: NOTE_ID, quote: null, page: null, note: "Izmišljena bilješka." },
  ]);
};

// SRV-1102: an invented JPEG excerpt in a multipart form.
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
const BOUNDARY = "izmisljena-granica";
const PROOF_FORM = Buffer.concat([
  Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="page"\r\n\r\n14\r\n`),
  Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="image"; filename="isjecak.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`,
  ),
  JPEG,
  Buffer.from(`\r\n--${BOUNDARY}--\r\n`),
]);
const PROOFS = `${STUDENT_ASSIGNMENT}/sources/${WORK_SOURCE.id}/proofs`;
const ADD_PROOF: Step = {
  path: PROOFS,
  as: "student",
  method: "POST",
  headers: { ...ORIGIN, "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
  raw: PROOF_FORM,
};

const PNG_BASE64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString(
  "base64",
);
const ADD_ATTACHMENT: Step = {
  path: `${STUDENT_ASSIGNMENT}/attachments`,
  as: "student",
  headers: ORIGIN,
  body: { imageBase64: PNG_BASE64 },
};

const SUBMIT: Step = {
  path: "/api/v1/submission",
  as: "student",
  headers: EVIDENCE,
  body: { documentId: IDS.document, revision: 1 },
};
const SUBMIT_STEPS = [commit("izmisljena-transakcija-1", 0), SUBMIT];
const PORTABLE_SUBMISSION = "c1312000-0000-4000-8000-000000000001";
const pinPortableSubmission = (state: State) => {
  const receipt = state.works.find((work) => work.submissionReceipt !== null)?.submissionReceipt;
  if (receipt) Object.assign(receipt.payload, { submissionId: PORTABLE_SUBMISSION });
};
// The fake's own token of that submission and kind, valid far past any test clock.
const PACKAGE_EXPIRES = 4_102_444_800_000;
const PACKAGE_TOKEN = `${PACKAGE_EXPIRES}.${createHash("sha256")
  .update(`${PORTABLE_SUBMISSION}\npackage\n${PACKAGE_EXPIRES}`)
  .digest("base64url")}`;

// SRV-1703: an invented draft and an invented bank entry. The fake numbers
// what it stores in order (comments-routes.ts nextId): the first draft is
// thread 1 and comment 2, the first bank entry id 1.
const DRAFT_COMMENT_ID = "c1700000-0000-4000-8000-000000000002";
const BANK_ENTRY_ID = "c1700000-0000-4000-8000-000000000001";
const DRAFT_STEP: Step = {
  path: `/api/v1/works/${IDS.document}/comment-drafts`,
  as: "nastavnik",
  headers: ORIGIN,
  body: {
    text: "Izmišljena napomena o izvoru.",
    anchor: {
      nodeId: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c02",
      quote: "izmišljeni odlomak",
      prefix: "",
      suffix: "",
      startHint: 0,
      endHint: 18,
    },
  },
};
const BANK_STEP: Step = {
  path: "/api/v1/teacher/comment-bank",
  as: "nastavnik",
  headers: ORIGIN,
  body: { text: "Izmišljeno: navedite izvor.", kind: "must" },
};

const MENTORSHIP_REQUESTS = "/api/v1/mentorship-requests";
const MENTOR_NOTES = `/api/v1/mentorships/${IDS.mentorship}/notes`;
const REQUEST_MENTORSHIP: Step = {
  path: MENTORSHIP_REQUESTS,
  as: "student",
  headers: ORIGIN,
  body: { teacherId: IDS.teacher, workType: "master_thesis" },
};
const MENTORSHIP_REQUEST = `${MENTORSHIP_REQUESTS}/b1400000-0000-4000-8000-000000000001`;

const SCENARIOS: Record<RouteId, Scenario> = {
  "mentorship.requests.post": { request: REQUEST_MENTORSHIP },
  "mentorship.student-requests.get": {
    before: [REQUEST_MENTORSHIP],
    request: { path: "/api/v1/student/mentorship-requests", as: "student" },
  },
  "mentorship.student-mentor-candidates.get": {
    request: { path: "/api/v1/student/mentor-candidates", as: "student" },
  },
  "mentorship.key-dates.get": {
    request: { path: `/api/v1/mentorships/${IDS.mentorship}/key-dates`, as: "student" },
  },
  "mentorship.notes.get": { request: { path: MENTOR_NOTES, as: "nastavnik" } },
  "mentorship.notes.post": {
    request: {
      path: MENTOR_NOTES,
      as: "nastavnik",
      method: "POST",
      headers: ORIGIN,
      body: { body: "Izmisljena privatna biljeska." },
    },
  },
  "mentorship.request-approve.post": {
    before: [REQUEST_MENTORSHIP],
    request: { path: `${MENTORSHIP_REQUEST}/approve`, as: "nastavnik", headers: ORIGIN },
  },
  "mentorship.request-decline.post": {
    before: [REQUEST_MENTORSHIP],
    request: {
      path: `${MENTORSHIP_REQUEST}/decline`,
      as: "nastavnik",
      headers: ORIGIN,
      body: { reason: "Izmišljeni razlog." },
    },
  },
  "mentorship.request-withdraw.post": {
    before: [REQUEST_MENTORSHIP],
    request: { path: `${MENTORSHIP_REQUEST}/withdraw`, as: "student", headers: ORIGIN },
  },
  "student.declaration.get": {
    request: { path: `/api/v1/student/assignments/${IDS.assignment}/declaration`, as: "student" },
  },
  "student.declaration.put": {
    before: [commit("c0000000-0000-4000-8000-000000000197", 0)],
    request: {
      path: `/api/v1/student/assignments/${IDS.assignment}/declaration`,
      as: "student",
      method: "PUT",
      headers: ORIGIN,
      body: {
        baseVersion: 0,
        revision: 1,
        form: { formId: "test-izjava", formVersion: 1, formSha256: "a".repeat(64) },
        ownWork: { confirmed: false },
        humanHelp: { received: false, entries: [] },
        ai: { use: null, declaredTools: [], attachments: [], externalAttachmentIds: [] },
        confirm: false,
      },
    },
  },
  "student.declaration-attachments.post": {
    request: {
      path: `/api/v1/student/assignments/${IDS.assignment}/declaration-attachments`,
      as: "student",
      method: "POST",
      headers: { ...ORIGIN, "content-type": "text/plain" },
      raw: "Izmišljeni ispis",
    },
  },
  "student.assistant-request.post": {
    request: {
      path: "/api/v1/student/assistant/requests",
      as: "student",
      headers: { ...ORIGIN, "idempotency-key": "5f0c3a9e-2b7d-4c1e-9a6f-0d8e7b4c2a11" },
      body: {
        assignmentId: IDS.assignment,
        conversationId: null,
        purposeCatalogVersion: 1,
        purposeKey: "proofreading",
        paragraph: "Izmišljeni odlomak o vodenim mlinovima.",
      },
    },
  },
  "student.assistant-conversation.get": {
    request: {
      path: "/api/v1/student/assistant/conversations/00000000-0000-4000-8000-0000000000c1",
      as: "student",
    },
  },
  "work.interview.get": { before: [ADD_QUESTION], request: { path: INTERVIEW, as: "nastavnik" } },
  "work.interview-pdf.get": {
    before: [ADD_QUESTION, INVITE],
    request: { path: `${INTERVIEW}/pdf`, as: "nastavnik" },
  },
  "work.interview-questions.post": { request: ADD_QUESTION },
  "work.interview-questions.delete": {
    before: [ADD_QUESTION],
    request: {
      path: `${INTERVIEW}/questions/${INTERVIEW_QUESTION_ID}`,
      as: "nastavnik",
      method: "DELETE",
      headers: ORIGIN,
    },
  },
  "work.interview-invite.post": { before: [ADD_QUESTION], request: INVITE },
  "work.interview-appointment.put": {
    request: {
      path: `${INTERVIEW}/appointment`,
      as: "nastavnik",
      method: "PUT",
      headers: ORIGIN,
      body: { place: "Ured 12", at: new Date(Date.now() + 86_400_000).toISOString() },
    },
  },
  "work.interview-held.post": {
    before: [ADD_QUESTION, INVITE],
    request: {
      path: `${INTERVIEW}/held`,
      as: "nastavnik",
      headers: ORIGIN,
      body: { date: new Date().toISOString().slice(0, 10) },
    },
  },
  "work.interview-explanations.post": {
    before: [ADD_QUESTION, INVITE],
    request: {
      path: `${INTERVIEW}/explanations`,
      as: "student",
      headers: ORIGIN,
      body: { text: "Izmišljeno objašnjenje." },
    },
  },
  "work.consultation-slots.get": {
    before: [REQUEST_SLOT],
    request: { path: CONSULTATION_SLOTS, as: "nastavnik" },
  },
  "work.consultation-slots.post": { request: REQUEST_SLOT },
  "work.consultation-slots.patch": {
    before: [REQUEST_SLOT],
    request: {
      path: `${CONSULTATION_SLOTS}/c0200000-0000-4000-8000-000000000001`,
      as: "nastavnik",
      method: "PATCH",
      headers: ORIGIN,
      body: { action: "confirm" },
    },
  },
  "auth.backchannel-logout.post": {
    request: {
      path: "/api/v1/auth/backchannel-logout",
      body: "logout_token=izmisljeni",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
  },
  "auth.callback.get": { request: { path: "/api/v1/auth/callback" } },
  "auth.login.get": { request: { path: "/api/v1/auth/login" } },
  "auth.logout-all.post": {
    request: { path: "/api/v1/auth/logout-all", as: "student", method: "POST" },
  },
  "auth.logout.post": { request: { path: "/api/v1/auth/logout", as: "student", method: "POST" } },
  "auth.webauthn-assertion.post": {
    request: {
      path: "/api/v1/auth/webauthn/assertion",
      as: "student",
      body: { authenticatorData: "AA", clientDataJSON: "AA", credentialId: "AA", signature: "AA" },
    },
  },
  "auth.webauthn-challenge.post": {
    request: {
      path: "/api/v1/auth/webauthn/challenge",
      as: "student",
      body: { purpose: "registration" },
    },
  },
  "auth.webauthn-registration.post": {
    request: {
      path: "/api/v1/auth/webauthn/registration",
      as: "student",
      body: { authenticatorData: "AA", clientDataJSON: "AA", credentialId: "AA" },
    },
  },
  "public.verification.post": {
    request: {
      path: "/api/v1/public/verification",
      body: {
        submissionId: "00000000-0000-4000-8000-00000000c0de",
        artifactSha256: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      },
    },
  },
  "client.context.post": {
    request: {
      path: "/api/v1/client-context",
      body: {
        app: "web",
        appVersion: "1.0.0",
        browser: "firefox",
        device: "desktop",
        os: "linux",
        screen: "expanded",
      },
    },
  },
  "collaboration.comments.post": {
    before: [
      {
        path: "/api/v1/comments/create",
        as: "nastavnik",
        body: { anchor: ANCHOR, body: "Izmišljeni komentar.", documentId: IDS.document },
      },
    ],
    request: { path: "/api/v1/comments/list", as: "student", body: { documentId: IDS.document } },
  },
  "collaboration.revision-requests.post": {
    before: [createRequest],
    request: {
      path: "/api/v1/revision-requests/list",
      as: "student",
      body: { documentId: IDS.document },
    },
  },
  "downloads.manifest.get": { request: { path: "/api/v1/downloads/manifest" } },
  "evidence.commit.post": { request: commit("izmisljena-transakcija-1", 0) },
  "evidence.open.post": {
    request: {
      path: "/api/v1/evidence/open",
      as: "student",
      headers: EVIDENCE,
      body: { assignmentId: IDS.assignment },
    },
  },
  "evidence.replay.post": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: {
      path: "/api/v1/evidence/replay",
      as: "nastavnik",
      headers: EVIDENCE,
      body: { documentId: IDS.document, from: 0 },
    },
  },
  "institution.assignment.get": { request: { path: A, as: "nastavnik" } },
  "teacher.assignment-grade.get": {
    request: { path: `/api/v1/teacher/assignments/${IDS.assignment}/grade`, as: "nastavnik" },
  },
  "institution.enrollment-code-state.get": {
    request: {
      path: `${C}/enrollment-code/state`,
      as: "nastavnik",
    },
  },
  "institution.acknowledgment.post": {
    request: {
      path: `${A}/acknowledgment`,
      as: "student",
      body: { versionNo: 1, fingerprint: "0".repeat(64) },
    },
  },
  "institution.assignment-versions.post": {
    request: { path: `${A}/versions`, as: "nastavnik", body: VERSION },
  },
  "institution.admin-courses.post": {
    request: {
      path: "/api/v1/institution/admin/courses",
      as: "administrator",
      body: {
        name: "Izmišljeni kolegij administratorice",
        academicYear: "2026/2027",
        aiPolicy: "prohibited",
        holderId: IDS.teacher2,
        groups: ["Grupa A"],
      },
    },
  },
  "institution.course-assignments.post": {
    request: {
      path: `${C}/assignments`,
      as: "nastavnik",
      body: (({ expectedVersion: _v, ...content }) => ({
        requestKey: "b15e6f70-8192-4da4-8eb5-f60718293a05",
        ...content,
      }))(VERSION),
    },
  },
  "institution.course-group-teachers.post": {
    request: {
      path: `/api/v1/institution/groups/${IDS.groupA}/teachers`,
      as: "nastavnik",
      body: { teacherId: IDS.teacher2 },
    },
  },
  "institution.course-groups.get": { request: { path: `${C}/groups`, as: "nastavnik" } },
  "institution.teaching-team.get": { request: { path: TEAM, as: "nastavnik" } },
  "institution.teaching-team-view.get": { request: { path: `${TEAM}/view`, as: "nastavnik" } },
  "institution.teaching-team.post": { request: SET_TEAM },
  "institution.teaching-group-members.put": {
    before: [SET_TEAM],
    request: {
      path: `/api/v1/courses/${IDS.course}/groups/${IDS.groupA}/members`,
      method: "PUT",
      as: "nastavnik",
      headers: ORIGIN,
      body: { assistantIds: [IDS.teacher2], studentIds: [IDS.student] },
    },
  },
  "institution.course-groups.post": {
    request: { path: `${C}/groups`, as: "nastavnik", body: { name: "Grupa C" } },
  },
  "institution.courses.post": {
    request: {
      path: "/api/v1/institution/courses",
      as: "nastavnik",
      body: { name: "Izmišljeni kolegij", academicYear: "2026/2027", aiPolicy: "encouraged" },
    },
  },
  "institution.enrollment-code-revocation.post": {
    request: { path: `${C}/enrollment-code/revocation`, as: "nastavnik", body: {} },
  },
  "institution.enrollment-code.post": {
    request: {
      path: `${C}/enrollment-code`,
      as: "nastavnik",
      body: { validUntil: "2027-06-30T21:59:00Z" },
    },
  },
  "institution.enrollments.post": {
    request: {
      path: "/api/v1/institution/enrollments",
      as: "student-2",
      body: { code: "UPIS2026DEMO" },
    },
  },
  "institution.role-confirmation.post": {
    request: {
      path: `/api/v1/institution/teachers/${IDS.noRole}/role-confirmation`,
      as: "administrator",
      body: {},
    },
  },
  "institution.role-revocation.post": {
    request: {
      path: `/api/v1/institution/teachers/${IDS.teacher2}/role-revocation`,
      as: "administrator",
      body: {},
    },
  },
  "institution.student-removal.post": {
    request: { path: `${C}/students/${IDS.student}/removal`, as: "nastavnik", body: {} },
  },
  "institution.student-return.post": {
    request: { path: `${C}/students/${IDS.student}/return-permission`, as: "nastavnik", body: {} },
  },
  "institution.student-work-language.post": {
    request: {
      path: `${A}/students/${IDS.student}/work-language`,
      as: "nastavnik",
      body: { language: "en" },
    },
  },
  "institution.work-language.post": {
    request: {
      path: `${A}/work-language`,
      as: "nastavnik",
      body: { expectedVersion: 1, language: "en" },
    },
  },
  "institution.work-work-language.get": {
    request: { path: `${A}/works/${IDS.document}/work-language`, as: "nastavnik" },
  },
  "institution.work-work-language.post": {
    request: {
      path: `${A}/works/${IDS.document}/work-language`,
      as: "nastavnik",
      body: { language: null },
    },
  },
  "live.document.get": {
    before: [livePut],
    request: {
      path: `/api/v1/live/${IDS.document}`,
      as: "nastavnik",
      headers: { "ductus-protocol": "1" },
    },
  },
  "live.document.put": { request: livePut },
  "platform.health.get": { request: { path: "/api/v1/health" } },
  "platform.ready.get": { request: { path: "/api/v1/ready" } },
  "platform.status.get": { request: { path: "/api/v1/status" } },
  "profile.interface-locale.get": {
    request: { path: "/api/v1/profile/interface-locale", as: "student" },
  },
  "profile.interface-locale.post": {
    request: { path: "/api/v1/profile/interface-locale", as: "student", body: { locale: "en" } },
  },
  "profile.me.get": { request: { path: "/api/v1/me", as: "administrator" } },
  "profile.staff-affiliation.get": {
    request: { path: "/api/v1/me/staff-affiliation", as: "nastavnik" },
  },
  "projection.process-summary.post": {
    request: {
      path: "/api/v1/process-summary",
      as: "nastavnik",
      body: { documentId: IDS.document },
    },
  },
  "projection.process-summary-details.post": {
    request: {
      path: "/api/v1/process-summary/details",
      as: "nastavnik",
      body: { documentId: IDS.document },
    },
  },
  "settings.catalogue.get": { request: { path: "/api/v1/settings/catalogue", as: "student" } },
  "settings.values.get": {
    request: {
      path: "/api/v1/settings/values",
      as: "nastavnik",
      query: `?level=course&course=${IDS.course}`,
    },
  },
  "settings.values.put": {
    request: { path: "/api/v1/settings/values", as: "student", method: "PUT", body: SETTING },
  },
  "sources.lookup.post": {
    request: {
      path: "/api/v1/sources/lookup",
      as: "student",
      body: { kind: "doi", identifier: "10.99999/izmisljeni" },
    },
  },
  "student.access-log.get": {
    request: { path: `/api/v1/student/works/${IDS.document}/access-log`, as: "student" },
  },
  "work.access.get": {
    request: { path: `/api/v1/works/${IDS.document}/access`, as: "student" },
  },
  "student.assignment-requirements.get": {
    request: { path: `${STUDENT_ASSIGNMENT}/requirements`, as: "student" },
  },
  "student.assignment-work.get": {
    request: { path: "/api/v1/student/assignment-work", as: "student" },
  },
  "student.assignments.get": { request: { path: "/api/v1/student/assignments", as: "student" } },
  "student-work.start.post": {
    request: {
      path: `/api/v1/assignments/${IDS.assignment}/start`,
      method: "POST",
      as: "student",
      headers: ORIGIN,
    },
  },
  "student-work.works.get": { request: { path: "/api/v1/student/works", as: "student" } },
  "student.enrollments.post": {
    request: {
      path: "/api/v1/student/enrollments",
      as: "student-2",
      body: { code: "UPIS2026DEMO" },
    },
  },
  "student.notice.get": {
    request: { path: `${A.replace("/institution/", "/student/")}/notice`, as: "student" },
  },
  "student.notice-read.post": {
    request: {
      path: `${A.replace("/institution/", "/student/")}/notice-read`,
      as: "student",
      body: { versionNo: 1 },
    },
  },
  "student.submission.get": {
    request: { path: `${STUDENT_ASSIGNMENT}/submission`, as: "student" },
  },
  // SRV-1312: the fake draws the submission id at random; the scenario pins it.
  "student.portable-record.get": {
    before: SUBMIT_STEPS,
    prepare: (state) => {
      const receipt = state.works.find(
        (work) => work.submissionReceipt !== null,
      )?.submissionReceipt;
      if (receipt) Object.assign(receipt.payload, { submissionId: PORTABLE_SUBMISSION });
    },
    request: {
      path: `/api/v1/student/submissions/${PORTABLE_SUBMISSION}/portable-record`,
      as: "student",
    },
  },
  // SRV-1807: the same pinned submission id; the link is asked for, then followed.
  "student.submission-package-link.post": {
    before: SUBMIT_STEPS,
    prepare: pinPortableSubmission,
    request: {
      path: `/api/v1/student/submissions/${PORTABLE_SUBMISSION}/package-link`,
      as: "student",
      method: "POST",
      headers: ORIGIN,
      body: { kind: "referada" },
    },
  },
  "student.submission-package.get": {
    before: SUBMIT_STEPS,
    prepare: pinPortableSubmission,
    request: {
      path: `/api/v1/student/submissions/${PORTABLE_SUBMISSION}/package/package?token=${PACKAGE_TOKEN}`,
      as: "student",
    },
  },
  "student.receipt-pdf.get": {
    before: SUBMIT_STEPS,
    request: { path: `${STUDENT_ASSIGNMENT}/submission/pdf`, as: "student" },
  },
  "student.submission-notes.get": {
    before: [NOTE],
    request: { path: `${STUDENT_ASSIGNMENT}/submission-notes`, as: "student" },
  },
  "student.submission-notes.post": { request: NOTE },
  "student.text-check-config.get": {
    request: { path: `${STUDENT_ASSIGNMENT}/text-check-config`, as: "student" },
  },
  "work.attachments.post": { request: ADD_ATTACHMENT },
  "work.attachments.get": {
    before: [ADD_ATTACHMENT],
    request: {
      path: "/api/v1/work-attachments/00000000-0000-4000-8000-a00000000001",
      as: "student",
    },
  },
  "student.source-proofs.get": {
    before: [SAVE_SOURCE, ADD_PROOF],
    request: { path: PROOFS, as: "student" },
  },
  "student.source-proofs.post": { before: [SAVE_SOURCE], request: ADD_PROOF },
  "student.source-proof-image.get": {
    before: [SAVE_SOURCE, ADD_PROOF],
    request: { path: `${PROOFS}/00000000-0000-4000-8000-d00000000001/image`, as: "student" },
  },
  "student.work-sources.get": {
    request: { path: `${STUDENT_ASSIGNMENT}/sources`, as: "student" },
  },
  "work.source-notes.get": {
    before: [SAVE_SOURCE, ADD_NOTE],
    request: { path: SOURCE_NOTES, as: "student", method: "GET" },
  },
  "work.source-notes.post": { before: [SAVE_SOURCE], request: ADD_NOTE },
  "work.source-notes.patch": {
    before: [SAVE_SOURCE],
    prepare: seedNote,
    request: { ...ADD_NOTE, method: "PATCH", body: { noteId: NOTE_ID, page: "12–14" } },
  },
  "work.source-notes.delete": {
    before: [SAVE_SOURCE],
    prepare: seedNote,
    request: {
      path: `${SOURCE_NOTES}?noteId=${NOTE_ID}`,
      as: "student",
      method: "DELETE",
      headers: ORIGIN,
    },
  },
  "student.work-sources.put": { request: SAVE_SOURCE },
  "student.work-sources.delete": {
    before: [SAVE_SOURCE],
    request: {
      path: `${STUDENT_ASSIGNMENT}/sources/${WORK_SOURCE.id}`,
      as: "student",
      method: "DELETE",
      headers: ORIGIN,
    },
  },
  "submission.submit.post": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: SUBMIT,
  },
  "support.problem-report.post": {
    request: { path: "/api/v1/support/problem-report", as: "student", body: REPORT },
  },
  "support.problem-reports.post": {
    request: {
      path: "/api/v1/problem-reports",
      as: "student",
      body: {
        appVersion: REPORT.appVersion,
        category: REPORT.category,
        description: REPORT.description,
      },
    },
  },
  "teacher.access.get": { request: { path: "/api/v1/teacher/access", as: "nastavnik" } },
  "work.milestones.get": {
    request: { path: `/api/v1/works/${IDS.document}/milestones`, as: "student" },
  },
  "work.milestones.patch": {
    request: {
      method: "PATCH",
      path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}`,
      as: "nastavnik",
      headers: ORIGIN,
      body: { dueAt: "2026-12-03T15:30:00Z" },
    },
  },
  "work.milestone-states.get": {
    request: { path: `/api/v1/works/${IDS.document}/milestone-states`, as: "student" },
  },
  "work.milestones.details.patch": {
    request: {
      method: "PATCH",
      path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}/details`,
      as: "nastavnik",
      headers: ORIGIN,
      body: { title: "Prvi nacrt", dueAt: "2026-12-03T15:30:00Z" },
    },
  },
  "work.milestones.submit.post": {
    request: {
      method: "POST",
      path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}/submit`,
      as: "student",
      headers: ORIGIN,
    },
  },
  "work.milestones.request-revision.post": {
    before: [
      {
        method: "POST",
        path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}/submit`,
        as: "student",
        headers: ORIGIN,
      },
    ],
    request: {
      method: "POST",
      path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}/request-revision`,
      as: "nastavnik",
      headers: ORIGIN,
      body: { comment: "Dopuni uvod.", revisionDueAt: "2026-12-10T12:00:00Z" },
    },
  },
  "work.milestones.approve.post": {
    before: [
      {
        method: "POST",
        path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}/submit`,
        as: "student",
        headers: ORIGIN,
      },
    ],
    request: {
      method: "POST",
      path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}/approve`,
      as: "nastavnik",
      headers: ORIGIN,
      body: { message: "Dobro." },
    },
  },
  "work.milestones.delete": {
    request: {
      method: "DELETE",
      path: `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}`,
      as: "nastavnik",
      headers: ORIGIN,
    },
  },
  "work.consultation-records.get": {
    before: [commit("izmisljena-transakcija-1", 0), CREATE_CONSULTATION],
    request: { path: `/api/v1/works/${IDS.document}/consultation-records`, as: "student" },
  },
  "work.consultation-records.post": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: { ...CREATE_CONSULTATION, as: "nastavnik" },
  },
  "work.consultation-additions.post": {
    before: [commit("izmisljena-transakcija-1", 0), CREATE_CONSULTATION],
    request: {
      path: `/api/v1/works/${IDS.document}/consultation-records/000000c0-0000-4000-8000-000000000001/additions`,
      as: "nastavnik",
      headers: ORIGIN,
      body: { text: "Izmišljena dopuna." },
    },
  },
  "work.event-disputes.get": {
    before: [commit("izmisljena-transakcija-1", 0), CREATE_EVENT_DISPUTE],
    request: { path: `/api/v1/works/${IDS.document}/event-disputes`, as: "nastavnik" },
  },
  "institution.origin-thresholds.get": {
    request: { path: "/api/v1/institution/origin-thresholds", as: "administrator" },
  },
  "institution.origin-threshold.put": {
    request: {
      path: "/api/v1/institution/origin-thresholds/assistant_inserted",
      method: "PUT",
      as: "administrator",
      headers: ORIGIN,
      body: { thresholdPercent: 5, strictness: "hard" },
    },
  },
  "institution.origin-threshold.delete": {
    before: [
      {
        path: "/api/v1/institution/origin-thresholds/assistant_inserted",
        method: "PUT",
        as: "administrator",
        headers: ORIGIN,
        body: { thresholdPercent: 5, strictness: "hard" },
      },
    ],
    request: {
      path: "/api/v1/institution/origin-thresholds/assistant_inserted",
      method: "DELETE",
      as: "administrator",
      headers: ORIGIN,
    },
  },
  "work.origin-thresholds.get": {
    before: [
      {
        path: "/api/v1/institution/origin-thresholds/assistant_inserted",
        method: "PUT",
        as: "administrator",
        headers: ORIGIN,
        body: { thresholdPercent: 5, strictness: "hard" },
      },
    ],
    request: { path: `/api/v1/works/${IDS.document}/origin-thresholds`, as: "nastavnik" },
  },
  "work.origin-composition.get": {
    request: { path: `/api/v1/works/${IDS.document}/origin-composition`, as: "nastavnik" },
  },
  "work.event-disputes.post": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: CREATE_EVENT_DISPUTE,
  },
  "work.versions.get": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: { path: `/api/v1/works/${IDS.document}/versions`, as: "nastavnik" },
  },
  "work.export.get": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: { path: `/api/v1/works/${IDS.document}/export?format=docx`, as: "nastavnik" },
  },
  "work.export-pdf.get": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: {
      path: `/api/v1/assignments/${IDS.assignment}/works/${IDS.document}/export/pdf`,
      as: "student",
    },
  },
  "work.version.get": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: { path: `/api/v1/works/${IDS.document}/versions/1`, as: "student" },
  },
  "work.compare.get": {
    before: [commit("izmisljena-transakcija-1", 0)],
    prepare: (state) => {
      const work = state.works.find((w) => w.documentId === IDS.document);
      const document = work?.versionSnapshots.get(1);
      if (work !== undefined && document !== undefined) {
        work.revision = 2;
        work.versionSnapshots.set(2, document);
      }
    },
    request: { path: `/api/v1/works/${IDS.document}/compare?from=1&to=2`, as: "student" },
  },
  "work.messages.get": {
    before: [
      {
        path: `/api/v1/works/${IDS.document}/messages`,
        as: "student",
        body: { text: "Izmišljena poruka." },
      },
    ],
    request: { path: `/api/v1/works/${IDS.document}/messages`, as: "nastavnik" },
  },
  "notifications.list.get": {
    request: { path: "/api/v1/notifications", as: "student" },
  },
  "notifications.read.post": {
    request: {
      method: "POST",
      path: "/api/v1/notifications/00000000-0000-4000-8000-000000001701/read",
      as: "student",
    },
  },
  "work.direct-edit.get": {
    before: [
      {
        method: "PUT",
        path: `/api/v1/works/${IDS.document}/direct-edit`,
        as: "student",
        body: { mode: "direct" },
      },
    ],
    request: { path: `/api/v1/works/${IDS.document}/direct-edit`, as: "nastavnik" },
  },
  "work.direct-edit.put": {
    request: {
      method: "PUT",
      path: `/api/v1/works/${IDS.document}/direct-edit`,
      as: "student",
      body: { mode: "direct" },
    },
  },
  "work.imports.post": { request: POST_IMPORT },
  "work.imports.confirm.post": {
    before: [POST_IMPORT],
    request: {
      path: `${IMPORTS}/${FIRST_IMPORT.importId}/confirm`,
      as: "student",
      headers: ORIGIN,
      body: FIRST_IMPORT,
    },
  },
  "work.messages.post": {
    request: {
      path: `/api/v1/works/${IDS.document}/messages`,
      as: "student",
      body: { text: "Izmišljena poruka." },
    },
  },
  // SRV-1703 (D-51, N-03, N-05): delayed comments, the comment bank and the review mark.
  "work.comment-drafts.get": {
    before: [DRAFT_STEP],
    request: { path: `/api/v1/works/${IDS.document}/comment-drafts`, as: "nastavnik" },
  },
  "work.comment-drafts.post": { request: DRAFT_STEP },
  "work.comment-draft.delete": {
    before: [DRAFT_STEP],
    request: {
      path: `/api/v1/comment-drafts/${DRAFT_COMMENT_ID}`,
      as: "nastavnik",
      method: "DELETE",
      headers: ORIGIN,
    },
  },
  "work.comments.publish.post": {
    before: [DRAFT_STEP],
    request: {
      path: `/api/v1/works/${IDS.document}/comments/publish`,
      as: "nastavnik",
      headers: ORIGIN,
    },
  },
  "teacher.comment-bank.get": {
    before: [BANK_STEP],
    request: { path: "/api/v1/teacher/comment-bank", as: "nastavnik" },
  },
  "teacher.comment-bank.post": { request: BANK_STEP },
  "teacher.comment-bank.delete": {
    before: [BANK_STEP],
    request: {
      path: `/api/v1/teacher/comment-bank/${BANK_ENTRY_ID}`,
      as: "nastavnik",
      method: "DELETE",
      headers: ORIGIN,
    },
  },
  "work.review.post": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: {
      path: `/api/v1/works/${IDS.document}/review`,
      as: "nastavnik",
      headers: ORIGIN,
    },
  },
  "work.changes-since-review.get": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: { path: `/api/v1/works/${IDS.document}/changes-since-review`, as: "nastavnik" },
  },
  "teacher.assignment-submissions.post": {
    request: {
      path: "/api/v1/teacher/assignment-submissions",
      as: "nastavnik",
      body: { assignmentIds: [IDS.assignment] },
    },
  },
  "teacher.courses.get": { request: { path: "/api/v1/teacher/courses", as: "nastavnik-2" } },
  "institution.config.get": {
    request: { path: "/api/v1/institution/config", as: "administrator" },
  },
  "institution.config-versions.post": {
    request: {
      path: "/api/v1/institution/config/versions",
      as: "administrator",
      body: {
        expectedVersion: 0,
        citationStyle: "fpzg",
        workLanguages: ["hr", "en"],
        defaultWorkLanguage: "hr",
      },
    },
  },
  "institution.faculty-rules.get": {
    request: { path: "/api/v1/institution/faculty-rules", as: "administrator" },
  },
  "institution.faculty-rules.post": {
    request: {
      path: "/api/v1/institution/faculty-rules",
      as: "administrator",
      headers: ORIGIN,
      body: {
        workType: "essay",
        basedOnVersionNo: null,
        aiPolicy: "partially_allowed",
        aiPurposes: ["formatting"],
        evidenceProfile: "basic",
        importAllowed: false,
      },
    },
  },
  "ops.pilot-metrics.get": { request: { path: "/api/v1/ops/pilot-metrics", as: "administrator" } },
  "institution.retention.get": {
    request: { path: "/api/v1/institution/retention", as: "administrator" },
  },
  "course.aggregate.get": {
    request: { path: `/api/v1/courses/${IDS.course}/aggregate`, as: "nastavnik" },
  },
  "teacher.fast-path.post": {
    request: {
      path: "/api/v1/teacher/fast-path",
      as: "nastavnik",
      body: { assignmentId: IDS.assignment },
    },
  },
  "teacher.work.get": {
    request: { path: `/api/v1/teacher/works/${IDS.document}`, as: "nastavnik" },
  },
  "teacher.working-criteria.get": {
    request: { path: `/api/v1/teacher/works/${IDS.document}/working-criteria`, as: "nastavnik" },
  },
  "teacher.working-criterion.put": {
    request: {
      path: `/api/v1/teacher/works/${IDS.document}/working-criteria/sources`,
      as: "nastavnik",
      method: "PUT",
      headers: ORIGIN,
      body: { assessment: 1, note: "Izmišljena napomena." },
    },
  },
  "teacher.mentorship.get": {
    request: { path: `/api/v1/teacher/mentorships/${IDS.mentorship}`, as: "nastavnik" },
  },
  "teacher.mentorships.get": { request: { path: "/api/v1/teacher/mentorships", as: "nastavnik" } },
  "teacher.submissions.get": {
    before: SUBMIT_STEPS,
    request: { path: `/api/v1/teacher/assignments/${IDS.assignment}/submissions`, as: "nastavnik" },
  },
  "teacher.submission-detail.get": {
    before: SUBMIT_STEPS,
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/submissions/${IDS.student}`,
      as: "nastavnik",
    },
  },
  "teacher.receipt-pdf.get": {
    before: SUBMIT_STEPS,
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/submissions/${IDS.student}/pdf`,
      as: "nastavnik",
    },
  },
  "teacher.course-students.get": {
    request: { path: `/api/v1/teacher/courses/${IDS.course}/students`, as: "nastavnik" },
  },
  "teacher.assignment-overview.get": {
    before: SUBMIT_STEPS,
    request: { path: `/api/v1/teacher/assignments/${IDS.assignment}/overview`, as: "nastavnik" },
  },
  "teacher.submission-receipt.get": {
    before: SUBMIT_STEPS,
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/students/${IDS.student}/submission`,
      as: "nastavnik",
    },
  },
  "institution.legal-holds.get": {
    request: { path: "/api/v1/institution/legal-holds", as: "administrator" },
  },
  "institution.legal-holds.post": {
    request: {
      path: "/api/v1/institution/legal-holds",
      as: "administrator",
      body: {
        subjectType: "assignment",
        subjectId: IDS.assignment,
        caseReference: "IZMISLJENI-SLUCAJ-2026-01",
      },
    },
  },
  "institution.student-data-exports.get": {
    request: { path: "/api/v1/institution/student-data-exports", as: "bez-uloge" },
  },
  "institution.student-data-exports.post": {
    request: {
      path: "/api/v1/institution/student-data-exports",
      as: "bez-uloge",
      body: {
        studentId: IDS.student,
        identityCheckedBy: "identity_card",
        note: "IZMISLJENA-PROVJERA-2026-01",
      },
    },
  },
  "institution.student-data-exports-approve.post": {
    // A request the clerk made: the administrator, who did not request it, approves.
    prepare: (state) => {
      state.studentDataExports.push({
        exportId: "00000000-0000-4000-8000-0000000001f1",
        studentId: IDS.student,
        requestedBy: IDS.noRole,
        state: "requested",
        requestedAt: "2026-11-21T09:15:00.000Z",
        expiresAt: null,
        tokenHash: null,
      });
    },
    request: {
      path: "/api/v1/institution/student-data-exports/00000000-0000-4000-8000-0000000001f1/approve",
      as: "administrator",
      body: { reference: "IZMISLJENI-POSAO-2026-01" },
    },
  },
  "student.data-export.get": {
    // A ready export whose link is the token below; the fake has no worker.
    prepare: (state) => {
      state.studentDataExports.push({
        exportId: "00000000-0000-4000-8000-0000000001f1",
        studentId: IDS.student,
        requestedBy: IDS.noRole,
        state: "ready",
        requestedAt: "2026-11-21T09:15:00.000Z",
        expiresAt: "2999-01-01T00:00:00.000Z",
        tokenHash: studentDataExportTokenHashOf("IzmisljeniTokenPoveznice0123456789abcdefghi"),
      });
    },
    request: { path: "/api/v1/student/data-export/IzmisljeniTokenPoveznice0123456789abcdefghi" },
  },
  "institution.legal-hold-release.post": {
    // A hold another administrator placed: the one who placed it may not release it.
    prepare: (state) => {
      state.legalHolds.push({
        holdId: "00000000-0000-4000-8000-0000000000b1",
        subjectType: "assignment",
        subjectId: IDS.assignment,
        caseReference: "IZMISLJENI-SLUCAJ-2026-01",
        placedBy: "00000000-0000-4000-8000-0000000000a2",
        placedAt: "2026-11-20T08:00:00.000Z",
        releasedBy: null,
        releasedAt: null,
      });
    },
    request: {
      path: "/api/v1/institution/legal-holds/00000000-0000-4000-8000-0000000000b1/release",
      as: "administrator",
      body: { reason: "Izmišljeni razlog: slučaj je zaključen." },
    },
  },
  "teacher.declaration.get": {
    before: SUBMIT_STEPS,
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/students/${IDS.student}/declaration`,
      as: "nastavnik",
    },
  },
  "teacher.mentorship-requests.get": {
    request: { path: "/api/v1/teacher/mentorship-requests", as: "nastavnik" },
  },
  "teacher.mentorship-request-decision.post": {
    request: {
      path: "/api/v1/teacher/mentorship-requests/decision",
      as: "nastavnik",
      body: { requestId: IDS.mentorship, decision: "approve" },
    },
  },
  "student.deadline-history.get": {
    request: {
      path: `/api/v1/student/assignments/${IDS.assignment}/deadline-extensions`,
      as: "student",
      method: "GET",
    },
  },
  "teacher.deadline-extensions.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/deadline-extensions`,
      as: "nastavnik",
      method: "GET",
    },
  },
  "teacher.deadline-extension.post": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/deadline-extensions`,
      as: "nastavnik",
      body: { scope: "all", dueAt: "2030-01-01T12:00:00.000Z", reasonId: "all" },
    },
  },
  // SRV-1903: the student submits, then withdraws before the deadline.
  "student.submission-withdrawal.post": {
    before: [commit("izmisljena-transakcija-1", 0), SUBMIT],
    request: {
      path: `/api/v1/student/assignments/${IDS.assignment}/submission/withdrawal`,
      as: "student",
      method: "POST",
      headers: ORIGIN,
    },
  },
  "student.submission-withdrawal.get": {
    request: {
      path: `/api/v1/student/assignments/${IDS.assignment}/submission/withdrawal`,
      as: "student",
      method: "GET",
    },
  },
  "student.submission-history.get": {
    request: {
      path: `/api/v1/student/assignments/${IDS.assignment}/submission/history`,
      as: "student",
      method: "GET",
    },
  },
  "teacher.submission-history.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/students/${IDS.student}/submission-history`,
      as: "nastavnik",
      method: "GET",
    },
  },
  "teacher.submission-withdrawal.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/submission-withdrawal`,
      as: "nastavnik",
      method: "GET",
    },
  },
  "teacher.submission-withdrawal.post": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/submission-withdrawal`,
      as: "nastavnik",
      body: { allowed: false },
    },
  },
  "teacher.assignment-copy.post": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/copy`,
      as: "nastavnik",
      body: { requestKey: "00000000-0000-4000-8000-000000190401", courseId: IDS.course },
    },
  },
  "teacher.merlin-roster.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/merlin/roster`,
      as: "nastavnik",
      method: "GET",
    },
  },
  "teacher.merlin-roster-csv.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/merlin/csv`,
      as: "nastavnik",
      method: "GET",
    },
  },
  // SRV-1902: the teacher of the assignment asks for the link, then follows a far-future one.
  "teacher.submissions-bulk-link.post": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/submissions-bulk-link`,
      as: "nastavnik",
      method: "POST",
      headers: ORIGIN,
      body: { format: "pdf" },
    },
  },
  "teacher.submissions-bulk.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/submissions-bulk/docx?token=${bulkTokenFor(IDS.assignment, "docx", PACKAGE_EXPIRES)}`,
      as: "nastavnik",
    },
  },
  "teacher.merlin-packages.post": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/merlin/packages`,
      as: "nastavnik",
      body: { requestKey: "4b1e2c3d-0000-4000-8000-00000000aaa1" },
    },
  },
  "teacher.merlin-package.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/merlin/packages/00000000-0000-4000-8000-0000000000b1`,
      as: "nastavnik",
      method: "GET",
    },
  },
  "teacher.merlin-package-download.get": {
    request: {
      path: `/api/v1/teacher/assignments/${IDS.assignment}/merlin/packages/00000000-0000-4000-8000-0000000000b1/download`,
      as: "nastavnik",
      method: "GET",
    },
  },
};

async function run(state: State, step: Step) {
  const session = step.as === undefined ? {} : await signIn(state, step.as);
  const raw = typeof step.body === "string";
  return send(state, step.path, {
    ...step,
    ...(raw ? { body: undefined, raw: step.body as string } : {}),
    method: step.method ?? (step.body === undefined ? ROUTE_TABLE[routeOf(step)].method : "POST"),
    headers: { ...session, ...step.headers },
  });
}

function routeOf(step: Step): RouteId {
  const found = (Object.keys(ROUTE_TABLE) as RouteId[]).find((id) => {
    const pattern = new RegExp("^" + ROUTE_TABLE[id].path.replace(/\{\w+\}/g, "[^/]+") + "$");
    return pattern.test(step.path);
  });
  return found ?? "platform.health.get";
}

const ROUTES = Object.keys(ROUTE_TABLE) as RouteId[];

describe("dev fake server covers the whole contract", () => {
  it("refuses a work source whose record lacks its fields, and stores nothing", async () => {
    const state = createState();
    const step = { ...SAVE_SOURCE, body: { record: { id: WORK_SOURCE.id } } };
    expect((await run(state, step)).status).toBe(422);
    const read = SCENARIOS["student.work-sources.get"].request;
    expect(JSON.parse((await run(state, read)).body)).toEqual({ sources: [] });
  });

  it("takes a note with the CR LF line breaks of a form and drops the proofs of a removed source", async () => {
    const state = createState();
    expect((await run(state, SAVE_SOURCE)).status).toBe(200);
    const note = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nprvi\r\ndrugi\r\n`,
    );
    const added = await run(state, { ...ADD_PROOF, raw: Buffer.concat([note, PROOF_FORM]) });
    expect(added.status).toBe(201);
    expect(JSON.parse(added.body)).toMatchObject({ page: "14", note: "prvi\ndrugi" });
    const remove: Step = {
      path: SAVE_SOURCE.path,
      as: "student",
      method: "DELETE",
      headers: ORIGIN,
    };
    expect((await run(state, remove)).status).toBe(204);
    expect(state.sourceProofs).toEqual([]);
    expect((await run(state, SAVE_SOURCE)).status).toBe(200);
    const read = await run(state, { path: PROOFS, as: "student" });
    expect(JSON.parse(read.body)).toEqual({ proofs: [] });
  });

  it("never gives a new proof the id of one that still exists after a source is removed", async () => {
    const state = createState();
    const other = { ...WORK_SOURCE, id: "00000000-0000-4000-8000-00000000c0a2" };
    const saveOther: Step = {
      ...SAVE_SOURCE,
      path: `${STUDENT_ASSIGNMENT}/sources/${other.id}`,
      body: { record: other },
    };
    const addOther: Step = {
      ...ADD_PROOF,
      path: `${STUDENT_ASSIGNMENT}/sources/${other.id}/proofs`,
    };
    for (const step of [SAVE_SOURCE, saveOther, ADD_PROOF, addOther])
      expect((await run(state, step)).status).toBeLessThan(300);
    const remove: Step = {
      path: SAVE_SOURCE.path,
      as: "student",
      method: "DELETE",
      headers: ORIGIN,
    };
    expect((await run(state, remove)).status).toBe(204);
    expect((await run(state, addOther)).status).toBe(201);
    const ids = state.sourceProofs.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("has a handler and a scenario for every route of ROUTE_TABLE, and nothing else", () => {
    expect(Object.keys(DEV_HANDLERS).sort()).toEqual([...ROUTES].sort());
    expect(ROUTES.filter((route) => typeof DEV_HANDLERS[route] !== "function")).toEqual([]);
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ROUTES].sort());
  });

  it.each(ROUTES)("%s answers (not 501) and the answer fits the contract", async (route) => {
    const state = createState();
    const scenario = SCENARIOS[route];
    for (const step of scenario.before ?? [])
      expect((await run(state, step)).status).toBeLessThan(300);
    scenario.prepare?.(state);
    const answer = await run(state, scenario.request);
    expect(answer.status, answer.body).not.toBe(501);
    expect(answer.status, answer.body).toBeLessThan(400);
    expect(contractProblems(route, answer)).toEqual([]);
  });

  it.each(ROUTES)("%s answers every contract error it may be asked for", async (route) => {
    for (const code of errorCodes(route)) {
      const answer = await send(createState(), ROUTE_TABLE[route].path, {
        method: ROUTE_TABLE[route].method,
        headers: { "x-lazni-greska": code },
      });
      expect(contractProblems(route, answer, code), code).toEqual([]);
    }
  });
});

it("shares the changed milestone deadline and refuses changes after submission", async () => {
  const state = createState();
  const read = SCENARIOS["work.milestones.get"].request;
  const change = SCENARIOS["work.milestones.patch"].request;
  expect((await run(state, { ...read, as: "student-2" })).status).toBe(404);
  expect((await run(state, { ...change, as: "student" })).status).toBe(403);

  const updated = await run(state, change);
  expect(updated.status).toBe(200);
  expect(updated.json).toMatchObject({ id: IDS.milestone, dueAt: "2026-12-03T15:30:00.000Z" });
  for (const as of ["student", "nastavnik"] as const) {
    expect((await run(state, { ...read, as })).json).toEqual({ milestones: [updated.json] });
  }

  const submit = SCENARIOS["submission.submit.post"];
  for (const step of submit.before ?? []) expect((await run(state, step)).status).toBe(200);
  expect((await run(state, submit.request)).status).toBe(200);
  expect((await run(state, { ...change, body: { dueAt: "2026-12-04T12:00:00Z" } })).status).toBe(
    409,
  );
  expect((await run(state, read)).json).toEqual({ milestones: [updated.json] });
});

it("moves a milestone through submission, revision request and approval (SRV-1520)", async () => {
  const state = createState();
  const path = `/api/v1/works/${IDS.document}/milestones/${IDS.milestone}`;
  const post = (action: string, as: "student" | "nastavnik", body?: Record<string, unknown>) =>
    run(state, {
      method: "POST",
      path: `${path}/${action}`,
      as,
      headers: ORIGIN,
      ...(body && { body }),
    });
  expect((await post("submit", "nastavnik")).status).toBe(403);
  expect((await post("approve", "nastavnik", {})).status).toBe(409);
  expect((await post("submit", "student")).json).toMatchObject({
    state: "submitted",
    everSubmitted: true,
  });
  expect((await post("submit", "student")).status).toBe(409);
  expect((await post("approve", "student", {})).status).toBe(403);
  expect((await post("request-revision", "nastavnik", { comment: " " })).status).toBe(422);
  const revised = await post("request-revision", "nastavnik", { comment: "Dopuni uvod." });
  expect(revised.json).toMatchObject({
    state: "revision_requested",
    revisionComment: "Dopuni uvod.",
  });
  expect((await post("submit", "student")).json).toMatchObject({
    state: "submitted",
    revisionComment: null,
  });
  expect((await post("approve", "nastavnik", { message: "Dobro." })).json).toMatchObject({
    state: "approved",
    approvalMessage: "Dobro.",
  });
  const del = { method: "DELETE" as const, path, as: "nastavnik" as const, headers: ORIGIN };
  expect((await run(state, del)).status).toBe(409);
  const read = { path: `/api/v1/works/${IDS.document}/milestone-states`, as: "student" as const };
  expect((await run(state, read)).json).toMatchObject({ milestones: [{ state: "approved" }] });
});

describe("student submission on the dev fake server", () => {
  it("reads the exact receipt returned by submission", async () => {
    const state = createState();
    const read = SCENARIOS["student.submission.get"].request;
    expect(JSON.parse((await run(state, read)).body)).toEqual({ state: "none" });
    const submit = SCENARIOS["submission.submit.post"];
    for (const step of submit.before ?? []) expect((await run(state, step)).status).toBe(200);
    const submitted = await run(state, submit.request);
    expect(submitted.status).toBe(200);
    const confirmed = await run(state, read);
    expect(confirmed.status).toBe(200);
    expect(JSON.parse(confirmed.body)).toEqual({
      state: "potvrdeno",
      receipt: JSON.parse(submitted.body).receipt,
    });
    expect((await run(state, { ...read, as: "student-2" })).status).toBe(404);
  });

  it("shows a recorded submission awaiting a receipt", async () => {
    const state = createState();
    const work = state.works[0]!;
    work.submittedAt = "2026-11-20T10:00:00.125Z";
    work.revision = 1;
    const answer = await run(state, SCENARIOS["student.submission.get"].request);
    expect(contractProblems("student.submission.get", answer)).toEqual([]);
    expect(JSON.parse(answer.body)).toEqual({
      state: "ceka",
      revision: 1,
      requestedAt: "2026-11-20T10:00:00.125000Z",
    });
  });

  it("keeps notes append-only and private to the student", async () => {
    const state = createState();
    const read = SCENARIOS["student.submission-notes.get"].request;
    expect(JSON.parse((await run(state, read)).body)).toEqual({ notes: [] });
    const other = await run(state, { ...NOTE, as: "student-2" });
    expect(other.status).toBe(404);
    const added = await run(state, NOTE);
    expect(added.status).toBe(201);
    expect(JSON.parse((await run(state, read)).body)).toEqual({ notes: [JSON.parse(added.body)] });
    expect((await run(state, { ...read, as: "student-2" })).status).toBe(404);
  });
});

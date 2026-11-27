import { createHash, randomUUID } from "node:crypto";

import type { Operations } from "../../contracts/index.ts";
import { REVISION_ZERO_V3_JCS } from "../../../server/domain/index.ts";
import { createReceiptSigner, type ReceiptSigner, type SignedReceipt } from "./receipt-signer.ts";

// The in-memory state of the dev fake server and its invented starting data.
// People, courses, codes and the assignment are the values of SRV-01
// (db/main/local/seed.sql and db/main/local/lazni-oidc-racuni.json on
// migracija/w1119r-seed-lokalni, Ductus#2028), with fixed ids here, so the web
// sees the same names locally against the fake and against the real stack.
// Every person, text and id is invented.

export const ACCOUNT_KEYS = [
  "student",
  "student-2",
  "nastavnik",
  "nastavnik-2",
  "administrator",
  "operater",
  "bez-uloge",
] as const;
export type AccountKey = (typeof ACCOUNT_KEYS)[number];
export type Role = "student" | "teacher" | "institution_admin";
export type AiPolicy = "prohibited" | "partially_allowed" | "encouraged";
export type Language = "hr" | "en";

export type Account = {
  readonly id: string;
  readonly key: AccountKey;
  readonly givenName: string;
  readonly familyName: string;
  roles: Role[];
  locale: Language | null;
};

export type Group = {
  readonly id: string;
  readonly name: string;
  teacherIds: string[];
  studentIds: string[];
};

export type EnrollmentCode = { readonly code: string; validUntil: string; active: boolean };

export type Course = {
  readonly id: string;
  readonly name: string;
  readonly academicYear: string;
  readonly aiPolicy: AiPolicy;
  readonly holderId: string;
  readonly createdBy: string;
  studentIds: string[];
  groups: Group[];
  /** Explicit assistant roster; false marks a revoked assistant. */
  teachingAssistants?: Map<string, boolean>;
  codes: EnrollmentCode[];
  /** Removed students, refused by a code until a teacher lets them back. */
  removed: string[];
};

export type AssignmentContent = {
  title: string;
  instructions: string;
  workType:
    | "short_paper"
    | "essay"
    | "seminar_paper"
    | "bachelor_thesis"
    | "master_thesis"
    | "specialist_thesis"
    | "doctoral_thesis";
  opensAt: string;
  dueAt: string;
  aiPolicy: AiPolicy;
  aiPurposes: (
    "formatting" | "proofreading" | "literature_search" | "transcription" | "translation"
  )[];
  evidenceProfile: "basic" | "extended";
  importAllowed: boolean;
  wordMin: number | null;
  wordMax: number | null;
  /** UGOVORI-API, set only at creation: the course's groups it is for (lowercase). */
  groupIds?: string[];
  externalToolsAllowed?: boolean;
  aiSummaryOnly?: boolean;
  isPractice?: boolean;
};

export type Assignment = {
  readonly id: string;
  readonly courseId: string;
  version: number;
  content: AssignmentContent;
  language: Language;
  /** Version of the notice each student acknowledged, by student id. */
  acknowledged: Map<string, { version: number; at: string }>;
  /** When each student first read each version's notice (PO-7), by `${studentId}:${version}`. */
  read: Map<string, string>;
  /** The work language exception of one student's work, by student id (both language routes). */
  studentLanguage: Map<string, Language>;
};

export type Work = {
  readonly documentId: string;
  readonly assignmentId: string;
  readonly studentId: string;
  state: "in_progress" | "submitted";
  /** Revision of the saved text (evidence commits move it). */
  revision: number;
  lastChangeAt: string | null;
  /** When the submission was asked for, or null. */
  submittedAt: string | null;
  submissionReceipt: Operations["submission.submit.post"]["success"]["body"]["receipt"] | null;
  submittedDocument: string | null;
  /** The document of `revision`: standard base64 of its JSON bytes. */
  document: string;
  /**
   * Revision 0 of the work, standard base64 of its JSON bytes. Its schemaVersion is the
   * version of the work, as the real server reads it (SRV-7F).
   */
  readonly revisionZero: string;
  versionSnapshots: Map<number, string>;
  /** Segment texts in chain order (decoded from the commits). */
  segments: string[];
  lastSequenceTo: number;
  /** Client transaction id -> the original acknowledgement and snapshot hash. */
  transactions: Map<string, { receipt: SignedReceipt; documentHash: string }>;
  /** The live state (live.document.put) and its token, or null. */
  live: { readonly json: string; readonly token: string } | null;
};

/** A source of a student's work (SRV-7C); a teacher's carries its requirement. */
export type WorkSource = Operations["student.work-sources.put"]["success"]["body"] & {
  readonly assignmentId: string;
  readonly studentId: string;
};

export type Consultation = {
  id: string;
  documentId: string;
  heldOn: string;
  revision: number;
  topic: string;
  agreement: string;
  additions: { id: string; text: string; createdAt: string }[];
  /** F4 wave 2 #2: the whole minute it was held; null when none was given. */
  heldAt: string | null;
};

/** An amendment or dispute of a summary event (SRV-1315); only ever added. */
export type EventDispute = {
  disputeId: string;
  documentId: string;
  kind: "amendment" | "dispute";
  eventId: string;
  text: string;
  createdAt: string;
};

export type WorkMilestone = {
  id: string;
  title: string;
  description: string;
  dueAt: string | null;
  state: "open" | "submitted" | "approved" | "returned";
};

/** SRV-1520: what happened to one milestone of one work (key: documentId + "/" + milestoneId). */
export type MilestoneProgress = {
  state: "submitted" | "revision_requested" | "approved";
  submittedRevisionId: number;
  submittedAt: string;
  revisionComment: string | null;
  revisionDueAt: string | null;
  revisionRequestedAt: string | null;
  approvedAt: string | null;
  approvalMessage: string | null;
};

/** An image attached to a student's work (SRV-10C). */
export type Attachment = {
  readonly id: string;
  readonly documentId: string;
  readonly sha256: string;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly bytes: Buffer;
};

/** An excerpt attached to a source of a student's work (SRV-1102). */
export type SourceProof = {
  readonly id: string;
  readonly assignmentId: string;
  readonly studentId: string;
  readonly sourceId: string;
  readonly page: string;
  readonly note: string | null;
  readonly image: Buffer;
};

type SubmissionNote = Operations["student.submission-notes.post"]["success"]["body"] & {
  readonly assignmentId: string;
  readonly studentId: string;
};

/** An empty document of one paragraph, as base64 of its JSON bytes. */
export const EMPTY_DOCUMENT = Buffer.from(
  '{"nodes":[{"children":[],"id":"0a000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}',
).toString("base64");

/**
 * LOK-SRV-V3: an empty v3 work, the revision 0 the real server writes for schema 3
 * (REVISION_ZERO_V3_JCS of server/domain), as base64 of its JSON bytes.
 */
export const EMPTY_DOCUMENT_V3 = Buffer.from(REVISION_ZERO_V3_JCS).toString("base64");

/** The schema versions the fake can start works with: 1 (default) or 3. */
export type WorkSchema = 1 | 3;

/** Revision 0 of a new work of this schema. */
export const emptyDocumentOf = (schema: WorkSchema): string =>
  schema === 3 ? EMPTY_DOCUMENT_V3 : EMPTY_DOCUMENT;

/** The schema of the works from DUCTURA_LAZNI_SHEMA, or an error text for a bad value. */
export function devWorkSchema(
  env: Readonly<Record<string, string | undefined>>,
): WorkSchema | string {
  const raw = env.DUCTURA_LAZNI_SHEMA;
  if (raw === undefined || raw === "" || raw === "1") return 1;
  if (raw === "3") return 3;
  return `DUCTURA_LAZNI_SHEMA=${raw}: only 1 or 3`;
}

/** The version of a work and the SHA-256 of its revision 0, as evidence.open.post sends them. */
export function workVersion(work: Work): { schemaVersion: 1 | 3; revisionZeroHash: string } {
  const bytes = Buffer.from(work.revisionZero, "base64");
  const parsed = JSON.parse(bytes.toString("utf8")) as { schemaVersion?: unknown };
  return {
    schemaVersion: parsed.schemaVersion === 3 ? 3 : 1,
    revisionZeroHash: createHash("sha256").update(bytes).digest("hex"),
  };
}

export type Comment = {
  readonly id: string;
  readonly threadId: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly body: string;
  /** The anchor of the thread's first comment, else null. */
  readonly anchor: Record<string, unknown> | null;
  /** The revision of the work the thread was written on (INT-15-SRV); a reply has its thread's. */
  readonly revision: number | null;
  readonly at: string;
  deletedAt: string | null;
};

/** SRV-ED42-PRIJEDLOZI: a teacher's text suggestion on a work, as collaboration.suggestion keeps it. */
export type DevSuggestion = {
  readonly suggestionId: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly anchor: {
    readonly nodeId: string;
    readonly quote: string;
    readonly prefix: string;
    readonly suffix: string;
    readonly startHint: number;
    readonly endHint: number;
  };
  readonly text: string;
  readonly baseHash: string;
  state: "pending" | "accepted" | "rejected";
  readonly createdWindow: string;
  decidedWindow: string | null;
};

/** SRV-ED43-DORADA-POSALJI: one sent round of a work, with the counters of the open requests it answered. */
export type RevisionSend = {
  readonly documentId: string;
  readonly round: number;
  readonly message: string | null;
  readonly answered: Readonly<Record<string, number>>;
};

export type RevisionRequest = {
  readonly id: string;
  readonly documentId: string;
  readonly openerId: string;
  readonly openedAt: string;
  readonly anchor: Record<string, unknown>;
  instruction: string;
  requestedRevision: number;
  state: "open" | "responded" | "accepted" | "reopened" | "withdrawn";
  seq: number;
  version: number;
  response: {
    kind: "done" | "declined";
    explanation: string;
    revision: number;
    byId: string;
    at: string;
  } | null;
  closing: {
    as: "accepted" | "reopened" | "withdrawn";
    byId: string;
    at: string;
    acceptedRevision: number | null;
    rangeHash: string | null;
  } | null;
};

export type Mentorship = {
  readonly id: string;
  readonly mentorId: string;
  readonly studentId: string;
  readonly assignmentId: string;
  readonly title: string;
  readonly dueAt: string;
  readonly workType: "bachelor_thesis" | "master_thesis" | "specialist_thesis" | "doctoral_thesis";
  documentId: string | null;
};

/** SRV-1407: a mentorship request and where it ended. */
export type MentorshipRequest = {
  readonly id: string;
  readonly studentId: string;
  readonly teacherId: string;
  readonly workType: Mentorship["workType"];
  state: "requested" | "approved" | "declined" | "withdrawn";
  mentorshipId: string | null;
  /** SRV-1414: when it was made and when it ended, for the student's list. */
  readonly requestedAt: string;
  endedAt: string | null;
};

export type AccessEntry = {
  readonly id: string;
  readonly documentId: string;
  readonly readerId: string;
  readonly at: string;
  readonly role: "teacher" | "mentor" | "seminar_teacher" | "unknown";
  readonly surface:
    "live_view" | "process_summary" | "fast_path" | "replay" | "submitted_text" | "unknown";
};

export type SettingValue = {
  value: boolean | number | string | null;
  bound: { locked: true } | { min?: number; max?: number } | null;
  updatedAt: string;
};

export type State = {
  readonly receiptSigner: ReceiptSigner;
  accounts: Account[];
  /** Session token -> account id. */
  sessions: Map<string, string>;
  courses: Course[];
  assignments: Assignment[];
  works: Work[];
  /** LOK-SRV-V3: the schema version of the starting and new works (DUCTURA_LAZNI_SHEMA). */
  readonly workSchema: WorkSchema;
  submissionNotes: SubmissionNote[];
  deadlineExtensions: (Operations["teacher.deadline-extension.post"]["success"]["body"]["extension"] & {
    assignmentId: string;
  })[];
  /** SRV-NF4-IZNIMKA-ZAPIS: the late-submission exceptions, oldest first; never changed or removed. */
  lateExceptions: (Operations["teacher.late-exception.post"]["success"]["body"]["exception"] & {
    assignmentId: string;
  })[];
  /** SRV-1306: the institution's legal holds, oldest first. */
  legalHolds: Operations["institution.legal-holds.get"]["success"]["body"]["holds"];
  /** SRV-1308: the clerks of the registry office (account ids); the fake's clerk is the account without a role. */
  registryClerks: string[];
  /** SRV-1308: the student data exports; the link token is kept only as its SHA-256 (hex). */
  studentDataExports: (Operations["institution.student-data-exports.get"]["success"]["body"]["exports"][number] & {
    studentId: string;
    requestedBy: string;
    tokenHash: string | null;
  })[];
  /** SRV-1903: each withdrawn submission with its withdrawal receipt, oldest first. */
  submissionWithdrawals: {
    assignmentId: string;
    studentId: string;
    submission: Operations["submission.submit.post"]["success"]["body"]["receipt"];
    withdrawal: Operations["student.submission-withdrawal.post"]["success"]["body"]["receipt"];
  }[];
  /** SRV-1903: the teacher's withdrawal switch by assignment id; none means allowed. */
  withdrawalSettings: Map<
    string,
    Operations["teacher.submission-withdrawal.get"]["success"]["body"]
  >;
  workSources: WorkSource[];
  sourceNotes: Map<string, Operations["work.source-notes.post"]["success"]["body"][]>;
  sourceProofs: SourceProof[];
  consultationSlots: {
    documentId: string;
    slot: Operations["work.consultation-slots.post"]["success"]["body"];
    /** SRV-MENTOR-1 (MK-3, MK-10): the topic and preparation of a request, if any. */
    detail?: {
      topic: string | null;
      preparation: { text: string; changedParagraphs: number; resolvedComments: number } | null;
    };
    /** SRV-MENTOR-1: set once the slot is withdrawn, declined or cancelled; work.consultation-slots.get leaves it out. */
    closed?: {
      state: "withdrawn" | "declined" | "cancelled";
      by: "student" | "teacher";
      reason: string | null;
      at: string;
    };
  }[];
  /** SRV-MENTOR-1 (MK-7): the opening of a mentorship by its teacher and the student's notice of it. */
  mentorshipOpenings: {
    mentorshipId: string;
    topic: string | null;
    openedAt: string;
    notificationId: string;
    readAt: string | null;
  }[];
  /** SRV-MENTOR-1 (MK-5): agreed tasks of the consultation records; marks are only added. */
  consultationTasks: {
    id: string;
    documentId: string;
    recordId: string;
    position: number;
    text: string;
    createdAt: string;
    marks: { done: boolean; at: string }[];
  }[];
  /** The interview preparation of a work (SRV-1530), with the author of each question. */
  workInterviews: Map<
    string,
    {
      invitedAt: string | null;
      questions: {
        authorId: string;
        question: Operations["work.interview-questions.post"]["success"]["body"];
      }[];
      explanations: Operations["work.interview-explanations.post"]["success"]["body"][];
      /** The student's notes (PIL-K-RAZGOVOR-SRV), with their SHA-256. */
      notes: Operations["work.interview-notes.post"]["success"]["body"][];
      appointment: Operations["work.interview.get"]["success"]["body"]["appointment"];
      heldOn: string | null;
    }
  >;
  attachments: Attachment[];
  /** Proofs attached so far, removed ones included: the next proof id never repeats. */
  sourceProofCount: number;
  /** Refused enrolment codes, by account id (too_many_attempts after five). */
  enrollmentGuesses: Map<string, number>;
  mentorships: Mentorship[];
  mentorshipRequests: MentorshipRequest[];
  mentorNotes: {
    id: string;
    mentorshipId: string;
    mentorId: string;
    body: string;
    createdAt: string;
  }[];
  /** Openings of a work by a reader, newest last. */
  accessLog: AccessEntry[];
  /** Setting rows by "<level>:<course or ->:<owner>:<key>". */
  settings: Map<string, SettingValue>;
  /** Problem reports sent, by account id. */
  reports: Map<string, number>;
  /**
   * SRV-ADMIN-1 (OA-7): the problem reports kept for the people they reach,
   * newest last, with the reporter's account (never shown) and the state trail.
   */
  problemReports: FakeProblemReport[];
  /** SRV-ADMIN-1 (OA-3): the administrator's log of actions, newest last. */
  adminActions: Operations["institution.admin-actions.get"]["success"]["body"]["entries"];
  comments: Comment[];
  /** Thread id -> its state. */
  threads: Map<string, "open" | "answered" | "resolved">;
  revisionRequests: RevisionRequest[];
  revisionSends: RevisionSend[];
  suggestions: DevSuggestion[];
  /** The consultation records of the works (SRV-1105), additions in the order made. */
  consultations: Consultation[];
  /** The amendments and disputes of summary events of the works (SRV-1315). */
  eventDisputes: EventDispute[];
  milestones: Map<string, WorkMilestone[]>;
  milestoneProgress: Map<string, MilestoneProgress>;
  /** The returns of whole works for revision (SRV-1606), in the order made. */
  workReturns: {
    id: string;
    documentId: string;
    round: number;
    comment: string;
    revisionDueAt: string | null;
    returnedAt: string;
    /** True once the student submitted again: the return is no longer open (F4-NAS-R16-SRV). */
    closed?: boolean;
  }[];
};

/**
 * A valid instant as ISO UTC with milliseconds, or null for an impossible
 * date (2027-02-30 passes the contract pattern and Date.parse rolls it over).
 */
export function parseInstant(text: string): string | null {
  const time = Date.parse(text);
  const date = /^(\d{4})-(\d{2})-(\d{2})T/u.exec(text);
  if (Number.isNaN(time) || date === null) return null;
  const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) return null;
  return new Date(time).toISOString();
}

/** An enrolment code as institution.enroll_with_code compares it: no whitespace or hyphen, upper case. */
export function normalizeCode(code: string): string {
  return code.replace(/[\s-]/gu, "").toUpperCase();
}

/** Fixed, invented ids (UUID v4 form) of the starting data. */
export const IDS = {
  milestone: "00000000-0000-4000-8000-000000001103",
  student: "5a000000-0000-4000-8000-000000000001",
  student2: "5a000000-0000-4000-8000-000000000002",
  teacher: "7e000000-0000-4000-8000-000000000001",
  teacher2: "7e000000-0000-4000-8000-000000000002",
  admin: "ad000000-0000-4000-8000-000000000001",
  operator: "ad000000-0000-4000-8000-000000000002",
  noRole: "0e000000-0000-4000-8000-000000000001",
  course: "c0000000-0000-4000-8000-000000000001",
  emptyCourse: "c0000000-0000-4000-8000-000000000002",
  groupA: "9a000000-0000-4000-8000-00000000000a",
  groupB: "9a000000-0000-4000-8000-00000000000b",
  assignment: "a5000000-0000-4000-8000-000000000001",
  document: "d0000000-0000-4000-8000-000000000001",
  mentorship: "3e000000-0000-4000-8000-000000000001",
  thesis: "a5000000-0000-4000-8000-000000000002",
  accessEntry: "ac000000-0000-4000-8000-000000000001",
} as const;

/** The enrolment codes of the starting data (the fixed texts of SRV-01). */
export const CODES = {
  valid: "UPIS2026DEMO",
  expired: "STARI2025KOD",
  emptyCourse: "PRAZNI2026DEMO",
} as const;

export const INSTITUTION = { slug: "demo-fakultet", displayName: "Demo fakultet (test)" } as const;

/**
 * The invented journal scope of a fake account, one derivation for every
 * route that names it (profile.me.get journalScope, teacher.access.get scope),
 * as the real server uses principalScope for both. Never a real identifier.
 */
export function fakeJournalScope(accountId: string): string {
  return createHash("sha256")
    .update(`ductura-fake-journal-scope-v1\n${accountId}`, "utf8")
    .digest("hex");
}

/**
 * The invented session tag of a fake session (profile.me.get sessionTag): a
 * new one for every role switch, the same within a session, as the real
 * server's accountSessionTag. Never a real identifier.
 */
export function fakeSessionTag(token: string): string {
  return createHash("sha256").update(`ductura-fake-session-tag-v1\n${token}`, "utf8").digest("hex");
}

function account(
  key: AccountKey,
  id: string,
  givenName: string,
  familyName: string,
  roles: Role[],
): Account {
  return { id, key, givenName, familyName, roles, locale: null };
}

/** A fresh state with the starting data; each call is independent. */
export function createState(
  receiptSigner = createReceiptSigner(),
  workSchema: WorkSchema = 1,
): State {
  return {
    receiptSigner,
    workSchema,
    accounts: [
      account("student", IDS.student, "Lucija", "Đaković", ["student"]),
      account("student-2", IDS.student2, "Marko", "Ljubić", ["student"]),
      account("nastavnik", IDS.teacher, "Petar", "Kranjčec", ["teacher"]),
      account("nastavnik-2", IDS.teacher2, "Maja", "Džombić", ["teacher"]),
      account("administrator", IDS.admin, "Vesna", "Upravić", ["institution_admin"]),
      // SEED-OIDC-OPERATER: demo-operater of the seed, a second administrator
      // who stands in for the operator (ops-routes.ts); no role of its own.
      account("operater", IDS.operator, "Oto", "Operić", ["institution_admin"]),
      account("bez-uloge", IDS.noRole, "Iva", "Neimenić", []),
    ],
    sessions: new Map(),
    courses: [
      {
        id: IDS.course,
        name: "Izmišljeni seminar iz ekologije grada",
        academicYear: "2026/2027",
        aiPolicy: "partially_allowed",
        holderId: IDS.teacher,
        createdBy: IDS.teacher,
        studentIds: [IDS.student],
        groups: [
          { id: IDS.groupA, name: "Grupa A", teacherIds: [], studentIds: [IDS.student] },
          { id: IDS.groupB, name: "Grupa B", teacherIds: [IDS.teacher2], studentIds: [] },
        ],
        codes: [
          { code: CODES.expired, validUntil: "2025-10-31T22:59:00.000Z", active: false },
          { code: CODES.valid, validUntil: "2027-09-30T21:59:00.000Z", active: true },
        ],
        removed: [],
      },
      {
        id: IDS.emptyCourse,
        name: "Izmišljeni praktikum iz urbane sociologije",
        academicYear: "2026/2027",
        aiPolicy: "encouraged",
        holderId: IDS.teacher,
        createdBy: IDS.teacher,
        studentIds: [],
        groups: [],
        codes: [{ code: CODES.emptyCourse, validUntil: "2027-09-30T21:59:00.000Z", active: true }],
        removed: [],
      },
    ],
    assignments: [
      {
        id: IDS.assignment,
        courseId: IDS.course,
        version: 1,
        content: {
          title: "Seminarski rad: kućno kompostiranje",
          instructions:
            "Opiši kako kućno kompostiranje u gradskom kućanstvu smanjuje količinu otpada. " +
            "Osloni se na najmanje tri izvora i citiraj ih prema uputama fakulteta.\n\n" +
            "Kolegij, zadatak i tekst su izmišljeni i služe samo za lokalni demo.",
          workType: "seminar_paper",
          opensAt: "2026-10-01T06:00:00.000Z",
          dueAt: "2027-01-31T22:59:00.000Z",
          aiPolicy: "partially_allowed",
          aiPurposes: ["proofreading", "literature_search"],
          evidenceProfile: "basic",
          // SRV-1803: the demo assignment allows import, so the local import can be tried.
          importAllowed: true,
          wordMin: 1500,
          wordMax: 2500,
        },
        language: "hr",
        acknowledged: new Map([[IDS.student, { version: 1, at: "2026-10-02T08:15:00.000Z" }]]),
        read: new Map([[`${IDS.student}:1`, "2026-10-02T08:14:00.000Z"]]),
        studentLanguage: new Map(),
      },
    ],
    works: [
      {
        documentId: IDS.document,
        assignmentId: IDS.assignment,
        studentId: IDS.student,
        state: "in_progress",
        revision: 0,
        lastChangeAt: "2026-11-09T19:55:00.000Z",
        submittedAt: null,
        submissionReceipt: null,
        submittedDocument: null,
        document: emptyDocumentOf(workSchema),
        revisionZero: emptyDocumentOf(workSchema),
        versionSnapshots: new Map(),
        segments: [],
        lastSequenceTo: 0,
        transactions: new Map(),
        live: null,
      },
    ],
    submissionNotes: [],
    deadlineExtensions: [],
    lateExceptions: [],
    legalHolds: [],
    registryClerks: [IDS.noRole],
    studentDataExports: [],
    submissionWithdrawals: [],
    withdrawalSettings: new Map(),
    workSources: [],
    sourceNotes: new Map(),
    sourceProofs: [],
    consultationSlots: [],
    mentorshipOpenings: [],
    consultationTasks: [],
    workInterviews: new Map(),
    attachments: [],
    sourceProofCount: 0,
    enrollmentGuesses: new Map(),
    mentorshipRequests: [],
    mentorNotes: [],
    mentorships: [
      {
        id: IDS.mentorship,
        mentorId: IDS.teacher,
        studentId: IDS.student,
        assignmentId: IDS.thesis,
        title: "Završni rad: zelene površine u izmišljenom gradu",
        dueAt: "2027-05-01T12:00:00.000Z",
        workType: "bachelor_thesis",
        documentId: null,
      },
    ],
    accessLog: [
      {
        id: IDS.accessEntry,
        documentId: IDS.document,
        readerId: IDS.teacher,
        at: "2026-11-10T08:05:00.000Z",
        role: "teacher",
        surface: "fast_path",
      },
    ],
    settings: new Map(),
    reports: new Map(),
    problemReports: seedProblemReports(),
    adminActions: seedAdminActions(),
    comments: [],
    threads: new Map(),
    revisionRequests: [],
    revisionSends: [],
    suggestions: [],
    consultations: [],
    eventDisputes: [],
    milestoneProgress: new Map(),
    workReturns: [],
    milestones: new Map([
      [
        IDS.document,
        [
          {
            id: IDS.milestone,
            title: "Nacrt",
            description: "Nacrt za pregled",
            dueAt: "2026-12-01T12:00:00.000Z",
            state: "open",
          },
        ],
      ],
    ]),
  };
}

/** SRV-ADMIN-1: a problem report as the fake keeps it; `reporterId` never leaves the fake. */
export type FakeProblemReport = Omit<
  Operations["support.problem-reports.get"]["success"]["body"]["reports"][number],
  "routedTo" | "statusChangedByMe"
> & {
  readonly reporterId: string;
  statusChangedById: string | null;
};

/** Three invented reports, one of each kind, so the screens have rows to show. */
function seedProblemReports(): FakeProblemReport[] {
  const report = (
    reference: string,
    category: "technical" | "account" | "course",
    description: string,
    createdAt: string,
    courseId: string | null,
  ): FakeProblemReport => ({
    reference,
    category,
    courseId,
    description,
    route: null,
    appVersion: "1.4.0",
    browser: { family: "other", major: null },
    syncState: null,
    createdAt,
    status: "received",
    statusChangedAt: null,
    statusChangedByRole: null,
    statusChangedById: null,
    reporterId: IDS.student,
  });
  return [
    report(
      "PR-0A1B2C3D4E",
      "technical",
      "Izmišljeni opis: stranica se sporo otvara.",
      "2026-11-20T08:00:00.000Z",
      null,
    ),
    report(
      "PR-3B4C5D6E7F",
      "account",
      "Izmišljeni opis: ne vidim svoj kolegij.",
      "2026-11-21T08:00:00.000Z",
      null,
    ),
    report(
      "PR-2A3B4C5D6E",
      "course",
      "Izmišljeni opis: ne vidim rok zadatka.",
      "2026-11-22T08:00:00.000Z",
      IDS.course,
    ),
  ];
}

/** An invented log: the operator appointed the administrator, who then acted. */
function seedAdminActions(): State["adminActions"] {
  return [
    {
      at: "2026-10-01T08:00:00.000Z",
      actorRole: "operator",
      action: "role_confirmed",
      subjectRole: "institution_admin",
      outcome: "completed",
    },
    {
      at: "2026-10-02T09:00:00.000Z",
      actorRole: "institution_admin",
      action: "role_confirmed",
      subjectRole: "teacher",
      outcome: "completed",
    },
    {
      at: "2026-10-05T10:00:00.000Z",
      actorRole: "institution_admin",
      action: "rule_published",
      subjectRole: null,
      outcome: "completed",
    },
  ];
}

export function accountByKey(state: State, key: AccountKey): Account {
  const found = state.accounts.find((a) => a.key === key);
  if (found === undefined) throw new Error(`no account ${key}`);
  return found;
}

/** Teachers of a course: its holder and the teachers of its groups. */
export function courseTeachers(course: Course): string[] {
  const groupTeachers = course.groups.flatMap((g) => g.teacherIds);
  return [
    course.holderId,
    ...groupTeachers.filter((id) => course.teachingAssistants?.get(id) !== false),
  ];
}

/** The course of a work, when it exists. */
export function courseOfWork(state: State, work: Work): Course | undefined {
  const assignment = state.assignments.find((a) => a.id === work.assignmentId);
  return state.courses.find((c) => c.id === assignment?.courseId);
}

/**
 * How an account may read a work: as its student, as a teacher who may see
 * that student (visibleStudents), or not at all.
 */
export function readerOf(state: State, work: Work | undefined, account: Account | null) {
  if (work === undefined || account === null) return null;
  if (work.studentId === account.id) return "owner" as const;
  const course = courseOfWork(state, work);
  return course !== undefined && visibleStudents(course, account).includes(work.studentId)
    ? ("teacher" as const)
    : null;
}

/**
 * The students of a course whose works `account` may see: all of them for the
 * holder, only those of the teacher's own groups for a group teacher
 * (app.teacher_assignment_students through institution.actor_group_work).
 */
export function visibleStudents(course: Course, account: Account): string[] {
  if (!teachesCourse(course, account)) return [];
  if (course.holderId === account.id) return [...course.studentIds];
  const own = course.groups.filter((g) => g.teacherIds.includes(account.id));
  return course.studentIds.filter((id) => own.some((g) => g.studentIds.includes(id)));
}

/**
 * Records that a reader opened a work, as the access log stores it: on the
 * five-minute grid, one row per reader, work, surface and window.
 */
export function recordOpening(
  state: State,
  entry: Omit<AccessEntry, "id" | "at">,
  now: Date,
): void {
  const time = now.getTime();
  const at = new Date(time - (time % 300_000)).toISOString();
  const same = state.accessLog.some(
    (e) =>
      e.documentId === entry.documentId &&
      e.readerId === entry.readerId &&
      e.surface === entry.surface &&
      e.at === at,
  );
  if (!same) state.accessLog.push({ ...entry, id: randomUUID(), at });
}

/**
 * A teacher of the course: one of its teachers who still holds a confirmed
 * teacher role, as institution.actor_course_role asks; a revoked role ends it.
 */
export function teachesCourse(course: Course, account: Account): boolean {
  return account.roles.includes("teacher") && courseTeachers(course).includes(account.id);
}

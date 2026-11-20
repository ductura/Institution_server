import { createHash, randomUUID } from "node:crypto";

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
  /** The document of `revision`: standard base64 of its JSON bytes. */
  document: string;
  /** Segment texts in chain order (decoded from the commits). */
  segments: string[];
  lastSequenceTo: number;
  /** Client transaction id -> the original acknowledgement and snapshot hash. */
  transactions: Map<string, { receipt: SignedReceipt; documentHash: string }>;
  /** The live state (live.document.put) and its token, or null. */
  live: { readonly json: string; readonly token: string } | null;
};

/** An empty document of one paragraph, as base64 of its JSON bytes. */
export const EMPTY_DOCUMENT = Buffer.from(
  '{"nodes":[{"children":[],"id":"0a000000-0000-4000-8000-000000000001","type":"paragraph"}],"schemaVersion":1}',
).toString("base64");

export type Comment = {
  readonly id: string;
  readonly threadId: string;
  readonly documentId: string;
  readonly authorId: string;
  readonly body: string;
  /** The anchor of the thread's first comment, else null. */
  readonly anchor: Record<string, unknown> | null;
  readonly at: string;
  deletedAt: string | null;
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
  readonly workType: "bachelor_thesis" | "master_thesis" | "specialist_thesis" | "doctoral_thesis";
  documentId: string | null;
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
  /** Refused enrolment codes, by account id (too_many_attempts after five). */
  enrollmentGuesses: Map<string, number>;
  mentorships: Mentorship[];
  /** Openings of a work by a reader, newest last. */
  accessLog: AccessEntry[];
  /** Setting rows by "<level>:<course or ->:<owner>:<key>". */
  settings: Map<string, SettingValue>;
  /** Problem reports sent, by account id. */
  reports: Map<string, number>;
  comments: Comment[];
  /** Thread id -> its state. */
  threads: Map<string, "open" | "answered" | "resolved">;
  revisionRequests: RevisionRequest[];
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
  student: "5a000000-0000-4000-8000-000000000001",
  student2: "5a000000-0000-4000-8000-000000000002",
  teacher: "7e000000-0000-4000-8000-000000000001",
  teacher2: "7e000000-0000-4000-8000-000000000002",
  admin: "ad000000-0000-4000-8000-000000000001",
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
export function createState(receiptSigner = createReceiptSigner()): State {
  return {
    receiptSigner,
    accounts: [
      account("student", IDS.student, "Lucija", "Đaković", ["student"]),
      account("student-2", IDS.student2, "Marko", "Ljubić", ["student"]),
      account("nastavnik", IDS.teacher, "Petar", "Kranjčec", ["teacher"]),
      account("nastavnik-2", IDS.teacher2, "Maja", "Džombić", ["teacher"]),
      account("administrator", IDS.admin, "Vesna", "Upravić", ["institution_admin"]),
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
          importAllowed: false,
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
        document: EMPTY_DOCUMENT,
        segments: [],
        lastSequenceTo: 0,
        transactions: new Map(),
        live: null,
      },
    ],
    enrollmentGuesses: new Map(),
    mentorships: [
      {
        id: IDS.mentorship,
        mentorId: IDS.teacher,
        studentId: IDS.student,
        assignmentId: IDS.thesis,
        title: "Završni rad: zelene površine u izmišljenom gradu",
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
    comments: [],
    threads: new Map(),
    revisionRequests: [],
  };
}

export function accountByKey(state: State, key: AccountKey): Account {
  const found = state.accounts.find((a) => a.key === key);
  if (found === undefined) throw new Error(`no account ${key}`);
  return found;
}

/** Teachers of a course: its holder and the teachers of its groups. */
export function courseTeachers(course: Course): string[] {
  return [course.holderId, ...course.groups.flatMap((g) => g.teacherIds)];
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

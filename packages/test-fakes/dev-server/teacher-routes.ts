// Teacher routes of the dev fake server: own courses, submissions, the fast
// path and mentorships. An assignment the caller does not teach reads as an
// empty list, as the contract says; the role alone opens no work (C-23).

import { createHash, randomUUID } from "node:crypto";

import type { Operations } from "../../contracts/index.ts";
import { successBody } from "./contract.ts";
import type { Handlers } from "./server.ts";
import {
  fakeJournalScope,
  recordOpening,
  teachesCourse,
  visibleStudents,
  type Account,
  type Assignment,
  type Mentorship,
  type State,
} from "./state.ts";
import { processSummary, textBlocks } from "./work.ts";

type FastPathStudent = Operations["teacher.fast-path.post"]["success"]["body"]["students"][number];

function taught(state: State, account: Account | null, assignmentId: string): Assignment | null {
  const assignment = state.assignments.find((a) => a.id === assignmentId.toLowerCase());
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account)
    ? assignment
    : null;
}

/** Students of the assignment's course whose works the caller may see. */
function studentsOf(state: State, account: Account | null, assignment: Assignment): string[] {
  const course = state.courses.find((c) => c.id === assignment.courseId);
  return course === undefined || account === null ? [] : visibleStudents(course, account);
}

function submissions(state: State, account: Account | null, assignment: Assignment | null) {
  if (assignment === null) return [];
  return studentsOf(state, account, assignment)
    .sort()
    .map((studentId) => {
      const work = state.works.find(
        (w) => w.assignmentId === assignment.id && w.studentId === studentId,
      );
      const documentId = work?.documentId ?? null;
      if (work?.submittedAt == null)
        return {
          studentId,
          documentId,
          submitted: false,
          revision: null,
          requestedMinute: null,
          afterDeadline: null,
        } as const;
      return {
        studentId,
        documentId,
        submitted: true,
        revision: work.revision,
        requestedMinute: `${work.submittedAt.slice(0, 16)}:00.000Z`,
        afterDeadline: work.submittedAt > assignment.content.dueAt,
      } as const;
    });
}

function mentorshipWork(state: State, m: Mentorship) {
  const student = state.accounts.find((a) => a.id === m.studentId);
  const base = {
    mentorshipId: m.id,
    assignmentId: m.assignmentId,
    student:
      student === undefined
        ? null
        : { givenName: student.givenName, familyName: student.familyName },
    title: m.title,
    workType: m.workType,
  };
  return m.documentId === null
    ? { ...base, documentId: null, workState: "not_started" as const }
    : { ...base, documentId: m.documentId, workState: "in_progress" as const };
}

// SRV-27: roster, overview, receipt and mentorship requests, from the same state.
function names(state: State, studentId: string) {
  const student = state.accounts.find((a) => a.id === studentId);
  return student === undefined
    ? { givenName: null, familyName: null }
    : { givenName: student.givenName, familyName: student.familyName };
}

function groupName(state: State, courseId: string, studentId: string): string | null {
  const course = state.courses.find((c) => c.id === courseId);
  return course?.groups.find((g) => g.studentIds.includes(studentId))?.name ?? null;
}

// SRV-1107: the teacher's private working criteria (B-9), kept per fake state,
// author and work. Only a teacher of the work reads or writes them; the student's
// routes never see them.
const FOLLOW_UP_STATES = {
  open: "open",
  reopened: "open",
  responded: "responded",
  accepted: "closed",
  withdrawn: "withdrawn",
} as const;

const CRITERIA = [
  ["topic", "workingCriteria.topic"],
  ["structure", "workingCriteria.structure"],
  ["sources", "workingCriteria.sources"],
  ["method", "workingCriteria.method"],
  ["language", "workingCriteria.language"],
  ["formatting", "workingCriteria.formatting"],
] as const;
type CriterionValue = { assessment: 0 | 1 | 2 | null; note: string | null };
const WORKING_CRITERIA = new WeakMap<State, Map<string, CriterionValue>>();

function taughtWork(state: State, account: Account | null, documentId: string): boolean {
  const work = state.works.find((w) => w.documentId === documentId);
  if (work === undefined || account === null) return false;
  const assignment = taught(state, account, work.assignmentId);
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  // A teacher of one group reaches only the works of that group's students (C-7).
  return course !== undefined && visibleStudents(course, account).includes(work.studentId);
}
function criterionKey(state: State, account: Account, documentId: string, id: string): string {
  if (!WORKING_CRITERIA.has(state)) WORKING_CRITERIA.set(state, new Map());
  return `${account.id}:${documentId}:${id}`;
}

export const TEACHER_HANDLERS: Handlers = {
  "course.aggregate.get": ({ state, account, params, header }) => {
    const site = header("sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return { error: "forbidden" };
    if (account === null) return { error: "unauthorized" };
    const course = state.courses.find((c) => c.id === params.id.toLowerCase());
    if (course?.holderId !== account.id || !teachesCourse(course, account)) {
      return { error: "not_found" };
    }
    const assignments = new Set(
      state.assignments.filter((a) => a.courseId === course.id).map((a) => a.id),
    );
    const stages = { notStarted: 0, inProgress: 0, submitted: 0 };
    for (const studentId of new Set(course.studentIds)) {
      const works = state.works.filter(
        (work) => work.studentId === studentId && assignments.has(work.assignmentId),
      );
      const stage = works.some((work) => work.state === "submitted")
        ? "submitted"
        : works.length > 0
          ? "inProgress"
          : "notStarted";
      stages[stage]++;
    }
    const started = stages.inProgress + stages.submitted;
    if (
      stages.notStarted + started < 5 ||
      Object.values(stages).some((count) => count > 0 && count < 5)
    ) {
      return { status: 200, body: { status: "suppressed" } };
    }
    return {
      status: 200,
      body: { status: "available", started, submitted: stages.submitted, stages },
    };
  },
  "teacher.receipt-pdf.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    const studentId = params.studentId.toLowerCase();
    if (assignment === null || !studentsOf(state, account, assignment).includes(studentId)) {
      return { error: "not_found" };
    }
    const work = state.works.find(
      (item) => item.assignmentId === assignment.id && item.studentId === studentId,
    );
    if (work?.submissionReceipt == null) return { error: "not_found" };
    return {
      status: 200,
      body: successBody(
        "teacher.receipt-pdf.get",
      ) as Operations["teacher.receipt-pdf.get"]["success"]["body"],
    };
  },
  "teacher.access.get": ({ account }) => {
    if (account === null) return { error: "unauthorized" };
    const scope = fakeJournalScope(account.id);
    return {
      status: 200,
      body: { access: account.roles.includes("teacher") ? "allowed" : "denied", scope },
    };
  },
  "teacher.courses.get": ({ state, account }) => {
    if (account === null || !account.roles.includes("teacher")) return { error: "forbidden" };
    const courses = state.courses
      .filter((c) => teachesCourse(c, account))
      .sort(
        (a, b) =>
          b.academicYear.localeCompare(a.academicYear) || a.name.localeCompare(b.name, "hr"),
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        academicYear: c.academicYear,
        aiPolicy: c.aiPolicy,
        assignments: state.assignments
          .filter((a) => a.courseId === c.id)
          .sort((a, b) => a.content.dueAt.localeCompare(b.content.dueAt))
          .map((a) => ({
            id: a.id,
            title: a.content.title,
            workType: a.content.workType,
            opensAt: a.content.opensAt,
            dueAt: a.content.dueAt,
            currentVersion: a.version,
            enrolledStudents: c.studentIds.length,
          })),
      }));
    return { status: 200, body: { courses } };
  },
  "teacher.submissions.get": ({ state, account, params }) => ({
    status: 200,
    body: { submissions: submissions(state, account, taught(state, account, params.assignmentId)) },
  }),
  "teacher.submission-detail.get": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    const studentId = params.studentId.toLowerCase();
    if (assignment === null || !studentsOf(state, account, assignment).includes(studentId)) {
      return { error: "not_found" };
    }
    const work = state.works.find(
      (item) => item.assignmentId === assignment.id && item.studentId === studentId,
    );
    if (work === undefined || work.submittedAt === null) return { error: "not_found" };
    if (work.submittedDocument === null || work.submissionReceipt === null)
      return { error: "unavailable" };
    recordOpening(
      state,
      {
        documentId: work.documentId,
        readerId: account.id,
        role: "teacher",
        surface: "submitted_text",
      },
      now,
    );
    const { revision, afterDeadline } = work.submissionReceipt.payload;
    return {
      status: 200,
      body: { studentId, revision, late: afterDeadline, document: work.submittedDocument },
    };
  },
  "teacher.assignment-submissions.post": ({ state, account, body }) => {
    const ids = [...new Set(body.assignmentIds.map((id) => id.toLowerCase()))];
    const assignments = ids.map((assignmentId) => ({
      assignmentId,
      submissions: submissions(state, account, taught(state, account, assignmentId)),
    }));
    return { status: 200, body: { assignments } };
  },
  "teacher.fast-path.post": ({ state, account, body, now }) => {
    const assignment = taught(state, account, body.assignmentId);
    if (assignment === null || account === null)
      return { status: 200, body: { kind: "ok", students: [] } };
    const students = studentsOf(state, account, assignment).flatMap((id): FastPathStudent[] => {
      const student = state.accounts.find((a) => a.id === id);
      if (student === undefined) return [];
      const names = { id, givenName: student.givenName, surname: student.familyName };
      const work = state.works.find((w) => w.assignmentId === assignment.id && w.studentId === id);
      if (work === undefined)
        return [
          {
            ...names,
            documentId: null,
            work: "notice_pending",
            lastChangeAt: null,
            record: null,
          } as const,
        ];
      recordOpening(
        state,
        {
          documentId: work.documentId,
          readerId: account.id,
          role: "teacher",
          surface: "fast_path",
        },
        now,
      );
      return [
        {
          ...names,
          documentId: work.documentId,
          work: work.state === "submitted" ? "submitted" : "writing",
          lastChangeAt: work.lastChangeAt,
          record: { pastesWithoutSource: 0, blocks: textBlocks(), summary: processSummary(work) },
        } as const,
      ];
    });
    students.sort((a, b) => (a.surname ?? "").localeCompare(b.surname ?? "", "hr"));
    return { status: 200, body: { kind: "ok", students } };
  },
  "teacher.mentorships.get": ({ state, account }) => ({
    status: 200,
    body: {
      works: state.mentorships
        .filter((m) => m.mentorId === account?.id)
        .map((m) => mentorshipWork(state, m)),
    },
  }),
  // SRV-2003: one work by its document id and its neighbours in the assignment, among the works the caller may read.
  "teacher.work.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (!taughtWork(state, account, params.documentId)) return { error: "not_found" };
    const work = state.works.find((w) => w.documentId === params.documentId)!;
    const ordered = state.works
      .filter(
        (w) => w.assignmentId === work.assignmentId && taughtWork(state, account, w.documentId),
      )
      .sort((a, b) => (a.studentId + a.documentId < b.studentId + b.documentId ? -1 : 1));
    const index = ordered.findIndex((w) => w.documentId === work.documentId);
    const assignment = state.assignments.find((a) => a.id === work.assignmentId);
    const { givenName, familyName } = names(state, work.studentId);
    const submitted = work.submittedAt !== null;
    const late =
      submitted && assignment !== undefined && work.submittedAt! > assignment.content.dueAt;
    return {
      status: 200,
      body: {
        documentId: work.documentId,
        studentId: work.studentId,
        studentName:
          givenName === null || familyName === null ? null : `${givenName} ${familyName}`,
        assignmentId: work.assignmentId,
        state: !submitted
          ? ("nije_predano" as const)
          : late
            ? ("nakon_roka" as const)
            : work.submissionReceipt === null
              ? ("ceka" as const)
              : ("predano" as const),
        prevDocumentId: ordered[index - 1]?.documentId ?? null,
        nextDocumentId: ordered[index + 1]?.documentId ?? null,
      },
    };
  },
  "teacher.working-criteria.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (!taughtWork(state, account, params.documentId)) return { error: "not_found" };
    const stored = WORKING_CRITERIA.get(state);
    return {
      status: 200,
      body: {
        criteria: CRITERIA.map(([id, label]) => ({
          id,
          label,
          assessment:
            stored?.get(criterionKey(state, account, params.documentId, id))?.assessment ?? null,
          note: stored?.get(criterionKey(state, account, params.documentId, id))?.note ?? null,
        })),
      },
    };
  },
  "teacher.working-criterion.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const known = CRITERIA.find(([id]) => id === params.criterionId);
    if (known === undefined || !taughtWork(state, account, params.documentId)) {
      return { error: "not_found" };
    }
    const key = criterionKey(state, account, params.documentId, known[0]);
    if (body.assessment === null && body.note === null) WORKING_CRITERIA.get(state)!.delete(key);
    else WORKING_CRITERIA.get(state)!.set(key, { assessment: body.assessment, note: body.note });
    return {
      status: 200,
      body: { id: known[0], label: known[1], assessment: body.assessment, note: body.note },
    };
  },
  "teacher.mentorship.get": ({ state, account, params }) => {
    const m = state.mentorships.find(
      (x) => x.id === params.mentorshipId && x.mentorId === account?.id,
    );
    return m === undefined
      ? { error: "not_found" }
      : { status: 200, body: { work: mentorshipWork(state, m) } };
  },
  "teacher.course-students.get": ({ state, account, params }) => {
    const course = state.courses.find((c) => c.id === params.courseId.toLowerCase());
    if (course === undefined || account === null || !teachesCourse(course, account))
      return { status: 200, body: { students: [] } };
    const assignments = state.assignments.filter((a) => a.courseId === course.id);
    const students = visibleStudents(course, account)
      .sort()
      .map((studentId) => ({
        studentId,
        ...names(state, studentId),
        groupName: groupName(state, course.id, studentId),
        assignments: assignments.map((a) => {
          const work = state.works.find(
            (w) => w.assignmentId === a.id && w.studentId === studentId,
          );
          if (work === undefined)
            return { assignmentId: a.id, documentId: null, workState: "not_started" as const };
          return {
            assignmentId: a.id,
            documentId: work.documentId,
            workState:
              work.submittedAt === null ? ("in_progress" as const) : ("submitted" as const),
          };
        }),
      }));
    return { status: 200, body: { students } };
  },
  "teacher.assignment-overview.get": ({ state, account, params }) => {
    const assignment = taught(state, account, params.assignmentId);
    const students = submissions(state, account, assignment).map((s) => {
      const base = {
        studentId: s.studentId,
        ...names(state, s.studentId),
        groupName: groupName(state, assignment?.courseId ?? "", s.studentId),
      };
      if (!s.submitted)
        return {
          ...base,
          submitted: false,
          requestedMinute: null,
          afterDeadline: null,
          evidenceRecord: null,
        } as const;
      const work = state.works.find(
        (w) => w.assignmentId === assignment?.id && w.studentId === s.studentId,
      );
      return {
        ...base,
        submitted: true,
        requestedMinute: s.requestedMinute,
        afterDeadline: s.afterDeadline,
        evidenceRecord: work?.submissionReceipt?.payload.evidenceRecord ?? null,
      } as const;
    });
    return { status: 200, body: { students } };
  },
  // SRV-NF4-POTVRDE-DORADE: the overview's students; first read and latest
  // acknowledgment in UTC minutes, the request with the latest change in a
  // five-minute window (P-03). No text of a request, no access log.
  "teacher.assignment-follow-up.get": ({ state, account, params }) => {
    const assignment = taught(state, account, params.assignmentId);
    const floor = (at: string, ms: number) =>
      new Date(Math.floor(Date.parse(at) / ms) * ms).toISOString();
    const students = submissions(state, account, assignment)
      .map((s) => s.studentId)
      .sort()
      .map((studentId) => {
        const reads = [...(assignment?.read ?? new Map<string, string>())]
          .filter(([key]) => key.startsWith(`${studentId}:`))
          .map(([, at]) => at)
          .sort();
        const ack = assignment?.acknowledged.get(studentId);
        const documents = new Set(
          state.works
            .filter((w) => w.assignmentId === assignment?.id && w.studentId === studentId)
            .map((w) => w.documentId),
        );
        const requests = state.revisionRequests
          .filter((r) => documents.has(r.documentId))
          .map((r) => {
            const times = [r.openedAt, r.response?.at, r.closing?.at].filter(
              (t): t is string => t !== undefined,
            );
            return { request: r, changedAt: times.sort().at(-1) ?? r.openedAt };
          })
          .sort((a, b) =>
            a.changedAt === b.changedAt
              ? b.request.seq - a.request.seq
              : a.changedAt < b.changedAt
                ? 1
                : -1,
          );
        const latest = requests[0];
        return {
          studentId,
          noticeReadAt: reads[0] === undefined ? null : floor(reads[0], 60_000),
          ...(ack === undefined
            ? { noticeAcknowledgedAt: null, noticeVersionNo: null }
            : { noticeAcknowledgedAt: floor(ack.at, 60_000), noticeVersionNo: ack.version }),
          ...(latest === undefined
            ? { revisionState: null, revisionChangedAt: null }
            : {
                revisionState: FOLLOW_UP_STATES[latest.request.state],
                revisionChangedAt: floor(latest.changedAt, 300_000),
              }),
          openRevisionCount: requests.filter(
            (r) => r.request.state === "open" || r.request.state === "reopened",
          ).length,
        };
      });
    return { status: 200, body: { students } };
  },
  // P-5 (c.7010418731): no work content, so this read writes no access log.
  "teacher.submission-receipt.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    const studentId = params.studentId.toLowerCase();
    if (assignment === null || !studentsOf(state, account, assignment).includes(studentId))
      return { error: "not_found" };
    const work = state.works.find(
      (item) => item.assignmentId === assignment.id && item.studentId === studentId,
    );
    if (work === undefined || work.submittedAt === null)
      return { status: 200, body: { state: "none" } };
    if (work.submissionReceipt === null)
      return {
        status: 200,
        body: {
          state: "ceka",
          revision: work.revision,
          requestedAt: `${work.submittedAt.slice(0, -1)}000Z`,
        },
      };
    return { status: 200, body: { state: "potvrdeno", receipt: work.submissionReceipt } };
  },
  "teacher.mentorship-requests.get": ({ account }) => {
    if (account === null || !account.roles.includes("teacher")) return { error: "forbidden" };
    return { status: 200, body: { requests: [] } };
  },
  // No request is stored: the fake commits any well-formed decision (approve gets an invented id).
  "teacher.mentorship-request-decision.post": ({ account, body }) => {
    if (account === null || !account.roles.includes("teacher")) return { error: "forbidden" };
    return body.decision === "approve"
      ? {
          status: 200,
          body: { decision: "approve", mentorshipId: "3e000000-0000-4000-8000-0000000000ff" },
        }
      : { status: 200, body: { decision: "decline" } };
  },
  "teacher.deadline-extensions.get": ({ state, account, params }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const extensions = state.deadlineExtensions
      .filter((extension) => extension.assignmentId === assignment.id)
      .map(({ assignmentId: _, ...extension }) => ({
        ...extension,
        reasonId: extension.createdBy === account?.id ? extension.reasonId : null,
      }));
    return { status: 200, body: { extensions } };
  },
  "teacher.deadline-extension.post": ({ state, account, params, body, now }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null || account === null) return { error: "not_found" };
    const studentId = body.scope === "one" ? body.studentId.toLowerCase() : null;
    if (studentId !== null && !studentsOf(state, account, assignment).includes(studentId))
      return { error: "not_found" };
    const previousDueAt = state.deadlineExtensions.reduce((dueAt, extension) => {
      if (extension.assignmentId !== assignment.id) return dueAt;
      if (extension.studentId !== null && extension.studentId !== studentId) return dueAt;
      return extension.dueAt > dueAt ? extension.dueAt : dueAt;
    }, new Date(assignment.content.dueAt).toISOString());
    if (body.dueAt <= previousDueAt) return { error: "invalid_input" };
    const extension = {
      id: randomUUID(),
      scope: body.scope,
      studentId,
      previousDueAt,
      dueAt: body.dueAt,
      reasonId: body.reasonId,
      createdBy: account.id,
      createdAt: now.toISOString(),
    };
    state.deadlineExtensions.push({ assignmentId: assignment.id, ...extension });
    return {
      status: 201,
      body: { extension, existingSubmissionsUnchanged: false },
    };
  },
  // SRV-1109: the Merlin roster from the fake submissions; a fingerprint is of
  // a stand-in text, since the fake renders no files.
  "teacher.merlin-roster.get": ({ state, account, params }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    return {
      status: 200,
      body: { rows: merlinRows(state, account, assignment), extensionReasons: [] },
    };
  },
  "teacher.merlin-roster-csv.get": ({ state, account, params }) =>
    taught(state, account, params.assignmentId) === null
      ? { error: "not_found" }
      : {
          status: 200,
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="merlin-popis.csv"',
          },
        },
  // SRV-1110: the Merlin package without state. The id comes from the caller,
  // the assignment and the key, so the same key is the same package; every
  // package of a taught assignment reads as built, with a stand-in
  // fingerprint, since the fake renders no files.
  "teacher.merlin-packages.post": ({ state, account, params, body }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null || account === null) return { error: "not_found" };
    return {
      status: 202,
      body: { id: merlinPackageId(account.id, assignment.id, body.requestKey), state: "ready" },
    };
  },
  "teacher.merlin-package.get": ({ state, account, params, now }) => {
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null || !LOWER_UUID.test(params.packageId)) return { error: "not_found" };
    return {
      status: 200,
      body: {
        id: params.packageId,
        state: "ready",
        downloadPath: `/api/v1/teacher/assignments/${assignment.id}/merlin/packages/${params.packageId}/download`,
        expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        sha256: merlinFakeSha256(params.packageId),
      },
    };
  },
  "teacher.merlin-package-download.get": ({ state, account, params }) =>
    taught(state, account, params.assignmentId) === null || !LOWER_UUID.test(params.packageId)
      ? { error: "not_found" }
      : {
          status: 200,
          headers: {
            "content-type": "application/zip",
            "content-disposition": 'attachment; filename="merlin-paket.zip"',
            "x-content-sha256": merlinFakeSha256(params.packageId),
          },
        },
};

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const merlinFakeSha256 = (packageId: string) =>
  createHash("sha256").update(`merlin-paket-${packageId}`).digest("hex");

/** A UUID v4 shape from the caller, the assignment and the key. */
function merlinPackageId(accountId: string, assignmentId: string, key: string): string {
  const h = createHash("sha256").update(`${accountId}|${assignmentId}|${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

type MerlinRow = Operations["teacher.merlin-roster.get"]["success"]["body"]["rows"][number];

function merlinRows(state: State, account: Account | null, assignment: Assignment): MerlinRow[] {
  const fake = (text: string) => createHash("sha256").update(text).digest("hex");
  return submissions(state, account, assignment)
    .map((s) => {
      const student = state.accounts.find((a) => a.id === s.studentId);
      const names =
        student === undefined
          ? { familyName: null, givenName: null }
          : { familyName: student.familyName, givenName: student.givenName };
      if (!s.submitted)
        return {
          ...names,
          submitted: false,
          submittedMinute: null,
          afterDeadline: null,
          pdfName: null,
          pdfSha256: null,
          docxName: null,
          docxSha256: null,
        } as MerlinRow;
      const base = `student-${s.studentId.replaceAll("-", "").slice(0, 8)}`;
      return {
        ...names,
        submitted: true,
        submittedMinute: s.requestedMinute,
        afterDeadline: s.afterDeadline,
        pdfName: `${base}.pdf`,
        pdfSha256: fake(`${base}.pdf`),
        docxName: `${base}.docx`,
        docxSha256: fake(`${base}.docx`),
      } as MerlinRow;
    })
    .sort((a, b) => (a.familyName ?? "\uffff").localeCompare(b.familyName ?? "\uffff", "hr"));
}

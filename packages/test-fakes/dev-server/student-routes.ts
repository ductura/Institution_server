// Student routes of the dev fake server: own courses and assignments, the
// state of own works and who opened them (PRODUCT §5 rule 17). Only the
// caller's own memberships and works are ever read.
import { createHash, randomUUID } from "node:crypto";

import { Value } from "@sinclair/typebox/value";

import { WorkSourceRecord } from "../../../server/contracts/index.ts";
import { enabledCheckIdsFor } from "../../../server/domain/index.ts";
import type { Operations } from "../../contracts/index.ts";
import { successBody } from "./contract.ts";

import type { Handlers } from "./server.ts";
import {
  teachesCourse,
  visibleStudents,
  type Account,
  type Assignment,
  type SourceProof,
  type State,
  type WorkSource,
} from "./state.ts";

/** Assignments of the courses the account is a student in. */
export function studentAssignments(state: State, account: Account): Assignment[] {
  const courses = new Set(
    state.courses.filter((c) => c.studentIds.includes(account.id)).map((c) => c.id),
  );
  return state.assignments.filter((a) => courses.has(a.courseId));
}

function ownAssignment(state: State, account: Account, id: string): Assignment | undefined {
  return studentAssignments(state, account).find(
    (assignment) => assignment.id === id.toLowerCase(),
  );
}

/** A source of the caller's own work (one the caller added or a teacher's), or undefined. */
function ownSource(state: State, account: Account, assignmentId: string, sourceId: string) {
  const assignment = ownAssignment(state, account, assignmentId);
  return state.workSources.find(
    (s) =>
      s.assignmentId === assignment?.id &&
      s.studentId === account.id &&
      s.id === sourceId.toLowerCase(),
  );
}

function proofAnswer(proof: SourceProof) {
  return {
    id: proof.id,
    page: proof.page,
    note: proof.note,
    imagePath: `/api/v1/student/assignments/${proof.assignmentId}/sources/${proof.sourceId}/proofs/${proof.id}/image`,
  };
}

export const STUDENT_HANDLERS: Handlers = {
  "student.assignments.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const own = studentAssignments(state, account);
    const courses = state.courses
      .filter((c) => c.studentIds.includes(account.id))
      .sort((a, b) => a.name.localeCompare(b.name, "hr") || a.id.localeCompare(b.id))
      .map((course) => ({
        id: course.id,
        name: course.name,
        assignments: own
          .filter((a) => a.courseId === course.id)
          .sort(
            (a, b) => a.content.dueAt.localeCompare(b.content.dueAt) || a.id.localeCompare(b.id),
          )
          .map((a) => ({
            id: a.id,
            title: a.content.title,
            dueAt: a.content.dueAt,
            noticeFirst: a.acknowledged.get(account.id)?.version !== a.version,
          })),
      }));
    return { status: 200, body: { courses } };
  },
  "student.assignment-work.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const assignments = studentAssignments(state, account)
      .map((a) => {
        const work = state.works.find((w) => w.assignmentId === a.id && w.studentId === account.id);
        const workState =
          work === undefined
            ? "not_started"
            : work.state === "submitted"
              ? "submitted"
              : "in_progress";
        // SRV-NF4-IZNIMKA-PREDAJA: the caller's own latest exception (the last record holds).
        const exception = state.lateExceptions.findLast(
          (e) => e.assignmentId === a.id && e.studentId === account.id,
        );
        return exception === undefined
          ? ({ assignmentId: a.id, workState } as const)
          : ({
              assignmentId: a.id,
              workState,
              lateException: { untilAt: exception.untilAt },
            } as const);
      })
      .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    return { status: 200, body: { assignments } };
  },
  // SRV-NF1-PREDANO: the confirmed receipt of each own assignment, as student.submission.get
  // reads it one by one; none and ceka are null.
  "student.assignment-submissions.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const assignments = studentAssignments(state, account)
      .map((a) => {
        const receipt = state.works.find(
          (w) => w.assignmentId === a.id && w.studentId === account.id,
        )?.submissionReceipt;
        return receipt == null
          ? ({ assignmentId: a.id, submittedAt: null, afterDeadline: null } as const)
          : {
              assignmentId: a.id,
              submittedAt: receipt.payload.requestedAt,
              afterDeadline: receipt.payload.afterDeadline,
            };
      })
      .sort((a, b) => a.assignmentId.localeCompare(b.assignmentId));
    return { status: 200, body: { assignments } };
  },
  // INT-31 (Ductus#2055): the assignments of the caller's mentorships, which
  // no course lists. The fake keeps no ended mentorships and no notice of a
  // mentored assignment, so every one is listed and asks for its notice first.
  "student.mentored-assignments.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    const assignments = state.mentorships
      .filter((m) => m.studentId === account.id)
      .sort(
        (a, b) => a.dueAt.localeCompare(b.dueAt) || a.assignmentId.localeCompare(b.assignmentId),
      )
      .map((m) => {
        const mentor = state.accounts.find((a) => a.id === m.mentorId);
        return {
          id: m.assignmentId,
          mentorshipId: m.id,
          title: m.title,
          dueAt: m.dueAt,
          noticeFirst: true,
          workType: m.workType,
          mentor:
            mentor === undefined
              ? null
              : { id: mentor.id, givenName: mentor.givenName, familyName: mentor.familyName },
          extendedDueAt: null,
        };
      });
    return { status: 200, body: { assignments } };
  },
  "student.deadline-history.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const extensions = state.deadlineExtensions.flatMap((extension) => {
      const { id, scope, studentId, previousDueAt, dueAt, reasonId, createdAt } = extension;
      return extension.assignmentId === assignment.id &&
        (studentId === null || studentId === account.id) &&
        reasonId !== null
        ? [{ id, scope, previousDueAt, dueAt, reasonId, createdAt }]
        : [];
    });
    return { status: 200, body: { extensions } };
  },
  // SRV-NF4-IZNIMKA-ZAPIS: only the caller's own exceptions, marked as such.
  "student.late-exceptions.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const exceptions = state.lateExceptions.flatMap((exception) =>
      exception.assignmentId === assignment.id && exception.studentId === account.id
        ? [
            {
              id: exception.id,
              kind: "exception" as const,
              untilAt: exception.untilAt,
              reasonId: exception.reasonId as NonNullable<typeof exception.reasonId>,
              createdAt: exception.createdAt,
            },
          ]
        : [],
    );
    return { status: 200, body: { exceptions } };
  },
  "student.submission.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const work = state.works.find(
      (item) => item.assignmentId === assignment.id && item.studentId === account.id,
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
  // SRV-KOD-POTVRDE: the fake derives the code from the bound receipt (the real server
  // draws it at random when the receipt is bound); a submission awaiting its receipt has none.
  "student.submission-confirmation-code.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const receipt = state.works.find(
      (item) => item.assignmentId === assignment.id && item.studentId === account.id,
    )?.submissionReceipt;
    if (receipt == null) return { status: 200, body: { code: null } };
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const digest = createHash("sha256").update(JSON.stringify(receipt.payload)).digest();
    let code = "";
    for (let index = 0; index < 16; index += 1) {
      if (index > 0 && index % 4 === 0) code += "-";
      code += alphabet[digest[index]! & 31];
    }
    return { status: 200, body: { code } };
  },
  "student.receipt-pdf.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    const work = state.works.find(
      (item) => item.assignmentId === assignment?.id && item.studentId === account.id,
    );
    if (work?.submissionReceipt == null) return { error: "not_found" };
    return {
      status: 200,
      body: successBody(
        "student.receipt-pdf.get",
      ) as Operations["student.receipt-pdf.get"]["success"]["body"],
    };
  },
  "student.assignment-requirements.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const { wordMin, wordMax } = assignment.content;
    const wordRange =
      wordMin !== null
        ? { min: wordMin, max: wordMax }
        : wordMax !== null
          ? { min: null, max: wordMax }
          : null;
    return { status: 200, body: { wordRange } };
  },
  "student.submission-notes.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const notes = state.submissionNotes
      .filter((note) => note.assignmentId === assignment.id && note.studentId === account.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(({ id, text, createdAt }) => ({ id, text, createdAt }));
    return { status: 200, body: { notes } };
  },
  // SRV-F4-NAS-R11: a teacher reads the notes of a student they may see; another's, an
  // unknown or an unrelated assignment or student is 404. The read leaves no access-log row.
  "teacher.submission-notes.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = state.assignments.find((a) => a.id === params.assignmentId.toLowerCase());
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    const studentId = params.studentId.toLowerCase();
    if (
      assignment === undefined ||
      course === undefined ||
      !teachesCourse(course, account) ||
      !visibleStudents(course, account).includes(studentId)
    )
      return { error: "not_found" };
    const notes = state.submissionNotes
      .filter((note) => note.assignmentId === assignment.id && note.studentId === studentId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(({ id, text, createdAt }) => ({ id, text, createdAt }));
    return { status: 200, body: { notes } };
  },
  "student.submission-notes.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, body.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const note = { id: randomUUID(), text: body.text, createdAt: now.toISOString() };
    state.submissionNotes.push({ ...note, assignmentId: assignment.id, studentId: account.id });
    return { status: 201, body: note };
  },
  // SRV-1101: the dev fake knows no institution profile or style, so it answers as an
  // institution that has set none (the real route reads the institution's setting).
  "student.text-check-config.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (ownAssignment(state, account, params.assignmentId) === undefined)
      return { error: "not_found" };
    return {
      status: 200,
      body: {
        enabledCheckIds: enabledCheckIdsFor(null),
        lektaProfileId: null,
        citationStyle: "fpzg",
      },
    };
  },
  "student.work-sources.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const sources = state.workSources
      .filter((s) => s.assignmentId === assignment.id && s.studentId === account.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(({ assignmentId: _a, studentId: _s, ...source }) => source);
    return { status: 200, body: { sources } };
  },
  "student.work-sources.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    // The wire checks one level only; the deep shape is checked here, as the real server does.
    if (!Value.Check(WorkSourceRecord, body.record) || body.record.id !== params.sourceId)
      return { error: "invalid_input" };
    const mine = state.workSources.filter(
      (s) => s.assignmentId === assignment.id && s.studentId === account.id,
    );
    const old = mine.find((s) => s.id === params.sourceId);
    if (old?.requirement != null) return { error: "not_found" };
    if (old === undefined && mine.length >= 500) return { error: "invalid_input" };
    const at = now.toISOString();
    const source = {
      id: params.sourceId,
      // The wire checks the record's deep shape; this fake stores what it was sent.
      record: body.record as WorkSource["record"],
      doi: body.doi ?? null,
      isbn: body.isbn ?? null,
      undated: body.undated ?? false,
      requirement: null,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    };
    state.workSources = state.workSources.filter((s) => s !== old);
    state.workSources.push({ ...source, assignmentId: assignment.id, studentId: account.id });
    return { status: 200 as const, body: source };
  },
  "student.work-sources.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = ownAssignment(state, account, params.assignmentId);
    if (assignment === undefined) return { error: "not_found" };
    const old = state.workSources.find(
      (s) =>
        s.assignmentId === assignment.id && s.studentId === account.id && s.id === params.sourceId,
    );
    if (old === undefined || old.requirement !== null) return { error: "not_found" };
    state.workSources = state.workSources.filter((s) => s !== old);
    state.sourceNotes.delete(`${old.assignmentId}:${old.studentId}:${old.id}`);
    // The proofs of the source go with it, as institution.delete_work_source removes them.
    state.sourceProofs = state.sourceProofs.filter(
      (p) =>
        !(
          p.assignmentId === old.assignmentId &&
          p.studentId === old.studentId &&
          p.sourceId === old.id
        ),
    );
    return { status: 204 };
  },
  // SRV-1102: the proofs of a source of the own work. The image arrives in
  // Base64 from the multipart reader; only a JPEG is kept, never a whole PDF.
  "student.source-proofs.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const source = ownSource(state, account, params.assignmentId, params.sourceId);
    if (source === undefined) return { error: "not_found" };
    const proofs = state.sourceProofs
      .filter(
        (p) =>
          p.studentId === account.id &&
          p.assignmentId === source.assignmentId &&
          p.sourceId === source.id,
      )
      .map(proofAnswer);
    return { status: 200, body: { proofs } };
  },
  "student.source-proofs.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const source = ownSource(state, account, params.assignmentId, params.sourceId);
    if (source === undefined) return { error: "not_found" };
    const image = Buffer.from(String(body.image as unknown), "base64");
    const jpeg =
      image.length >= 4 &&
      image.length <= 1_048_576 &&
      image[0] === 0xff &&
      image[1] === 0xd8 &&
      image[2] === 0xff;
    const mine = state.sourceProofs.filter(
      (p) => p.studentId === account.id && p.assignmentId === source.assignmentId,
    );
    if (!jpeg || mine.length >= 200) return { error: "invalid_input" };
    const proof = {
      // In order, so a script can name the proof it attached: …-d00000000001, then …02;
      // counted over every proof ever attached, so a removed one never lends its id.
      id: `00000000-0000-4000-8000-d${String((state.sourceProofCount += 1)).padStart(11, "0")}`,
      assignmentId: source.assignmentId,
      studentId: account.id,
      sourceId: source.id,
      page: body.page,
      note: body.note ?? null,
      image,
    };
    state.sourceProofs.push(proof);
    return { status: 201, body: proofAnswer(proof) };
  },
  "student.source-proof-image.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const source = ownSource(state, account, params.assignmentId, params.sourceId);
    const proof = state.sourceProofs.find(
      (p) =>
        p.studentId === account?.id &&
        p.sourceId === source?.id &&
        p.assignmentId === source?.assignmentId &&
        p.id === params.proofId.toLowerCase(),
    );
    if (proof === undefined) return { error: "not_found" };
    return {
      status: 200,
      headers: { "cache-control": "private, no-store" },
      body: new Blob([proof.image], { type: "image/jpeg" }),
    };
  },
  "student.access-log.get": ({ state, account, params, query }) => {
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (account === null || work === undefined || work.studentId !== account.id)
      return { error: "not_found" };
    const beforeAt = typeof query?.beforeAt === "string" ? query.beforeAt : null;
    const beforeId = typeof query?.beforeId === "string" ? query.beforeId : null;
    const continued = beforeAt !== null && beforeId !== null && !Number.isNaN(Date.parse(beforeAt));
    const entries = state.accessLog
      .filter((e) => e.documentId === work.documentId && (!continued || e.at < (beforeAt ?? "")))
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))
      .map((e) => {
        const reader = state.accounts.find((a) => a.id === e.readerId);
        return {
          id: e.id,
          at: e.at,
          role: e.role,
          surface: e.surface,
          reader:
            reader === undefined
              ? null
              : { givenName: reader.givenName, familyName: reader.familyName },
        };
      });
    return { status: 200, body: { entries, next: null, continued } };
  },
};

// The guidance of a teacher on sources on the dev fake server (SRV-1605):
// teacher.source-guidance.get, teacher.source-recommendation.put and .delete,
// teacher.source-proof-request.put and .delete, teacher.literature-seen.put,
// teacher.source-proofs.get, teacher.source-proof-image.get,
// teacher.course-literature.get, .put and .delete, student.course-literature.get
// and student.source-proof-requests.get. The holder of the course writes; every
// other teacher who reads the work (or teaches the course) only reads; the student
// reads the requests of the own work and the literature of the own course. A
// refusal is the one 404. The requests, the required literature and the marks
// live per fake state. The real rules are app.teacher_* and app.course_literature_*.
import { Value } from "@sinclair/typebox/value";

import { WorkSourceRecord } from "../../../server/contracts/index.ts";

import type { Handlers } from "./server.ts";
import {
  courseOfWork,
  readerOf,
  teachesCourse,
  type Account,
  type Course,
  type State,
  type Work,
} from "./state.ts";

type Request = {
  id: string;
  sourceId: string;
  instruction: string;
  dueAt: string;
  createdAt: string;
  closedAt: string | null;
  workKey: string;
};
type CourseSource = {
  id: string;
  record: unknown;
  doi: string | null;
  isbn: string | null;
  undated: boolean;
  createdAt: string;
  updatedAt: string;
};
type Kept = {
  requests: Request[];
  literature: Map<string, CourseSource[]>;
  seen: Map<string, string>;
  count: number;
};

const kept = new WeakMap<State, Kept>();
function keptOf(state: State): Kept {
  let value = kept.get(state);
  if (value === undefined) {
    value = { requests: [], literature: new Map(), seen: new Map(), count: 0 };
    kept.set(state, value);
  }
  return value;
}

const workKey = (work: Work) => `${work.assignmentId}:${work.studentId}`;
const byCreated = <T extends { createdAt: string; id: string }>(a: T, b: T) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** A work the caller reads as a teacher (not the owner), with the right to write. */
function workOf(state: State, account: Account | null, documentId: string) {
  const work = state.works.find((w) => w.documentId === documentId);
  if (work === undefined || account === null || readerOf(state, work, account) !== "teacher") {
    return undefined;
  }
  const course = courseOfWork(state, work);
  return { work, canWrite: course?.holderId === account.id };
}

function courseFor(state: State, account: Account | null, courseId: string) {
  const course = state.courses.find((c) => c.id === courseId.toLowerCase());
  if (course === undefined || account === null) return undefined;
  if (teachesCourse(course, account)) {
    return {
      course,
      role: course.holderId === account.id ? ("writer" as const) : ("reader" as const),
    };
  }
  return course.studentIds.includes(account.id) ? { course, role: "student" as const } : undefined;
}

const requestAnswer = ({ workKey: _key, ...request }: Request) => request;
const sourcesOf = (state: State, course: Course) =>
  [...(keptOf(state).literature.get(course.id) ?? [])].sort(byCreated);

export const TEACHER_SOURCE_HANDLERS: Handlers = {
  "teacher.source-guidance.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    if (found === undefined) return { error: "not_found" };
    const { work, canWrite } = found;
    const sources = state.workSources
      .filter((s) => s.assignmentId === work.assignmentId && s.studentId === work.studentId)
      .sort(byCreated)
      .map(({ assignmentId: _a, studentId: _s, ...source }) => ({
        ...source,
        proofCount: state.sourceProofs.filter(
          (p) =>
            p.assignmentId === work.assignmentId &&
            p.studentId === work.studentId &&
            p.sourceId === source.id,
        ).length,
      }));
    const proofRequests = keptOf(state)
      .requests.filter(
        (r) => r.workKey === workKey(work) && sources.some((s) => s.id === r.sourceId),
      )
      .sort(byCreated)
      .map(requestAnswer);
    const seenAt = keptOf(state).seen.get(workKey(work)) ?? null;
    return { status: 200, body: { canWrite, sources, proofRequests, literatureSeenAt: seenAt } };
  },
  "teacher.source-recommendation.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    if (found === undefined || !found.canWrite) return { error: "not_found" };
    const { work } = found;
    if (!Value.Check(WorkSourceRecord, body.record) || body.record.id !== params.sourceId) {
      return { error: "invalid_input" };
    }
    const mine = state.workSources.filter(
      (s) => s.assignmentId === work.assignmentId && s.studentId === work.studentId,
    );
    const old = mine.find((s) => s.id === params.sourceId);
    if (old !== undefined && old.requirement === null) return { error: "not_found" };
    if (old === undefined && mine.length >= 500) return { error: "invalid_input" };
    const at = now.toISOString();
    const source = {
      id: params.sourceId,
      record: body.record as (typeof mine)[number]["record"],
      doi: body.doi ?? null,
      isbn: body.isbn ?? null,
      undated: body.undated ?? false,
      requirement: body.requirement,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    };
    state.workSources = state.workSources.filter((s) => s !== old);
    state.workSources.push({
      ...source,
      assignmentId: work.assignmentId,
      studentId: work.studentId,
    });
    return { status: 200, body: source };
  },
  "teacher.source-recommendation.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    if (found === undefined || !found.canWrite) return { error: "not_found" };
    const { work } = found;
    const old = state.workSources.find(
      (s) =>
        s.assignmentId === work.assignmentId &&
        s.studentId === work.studentId &&
        s.id === params.sourceId,
    );
    if (old !== undefined && old.requirement === null) return { error: "not_found" };
    if (old !== undefined) {
      state.workSources = state.workSources.filter((s) => s !== old);
      state.sourceNotes.delete(`${old.assignmentId}:${old.studentId}:${old.id}`);
      state.sourceProofs = state.sourceProofs.filter(
        (p) =>
          !(
            p.assignmentId === work.assignmentId &&
            p.studentId === work.studentId &&
            p.sourceId === old.id
          ),
      );
      const own = keptOf(state);
      own.requests = own.requests.filter(
        (r) => !(r.workKey === workKey(work) && r.sourceId === old.id),
      );
    }
    return { status: 204 };
  },
  "teacher.source-proof-request.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    if (found === undefined || !found.canWrite) return { error: "not_found" };
    const { work } = found;
    const source = state.workSources.find(
      (s) =>
        s.assignmentId === work.assignmentId &&
        s.studentId === work.studentId &&
        s.id === params.sourceId,
    );
    if (source === undefined) return { error: "not_found" };
    if (Date.parse(body.dueAt) <= now.getTime()) return { error: "invalid_input" };
    const own = keptOf(state);
    const open = own.requests.find(
      (r) => r.workKey === workKey(work) && r.sourceId === source.id && r.closedAt === null,
    );
    if (open !== undefined) {
      open.instruction = body.instruction;
      open.dueAt = body.dueAt;
      return { status: 200, body: requestAnswer(open) };
    }
    const request: Request = {
      id: `00000000-0000-4000-8000-e${String((own.count += 1)).padStart(11, "0")}`,
      sourceId: source.id,
      instruction: body.instruction,
      dueAt: body.dueAt,
      createdAt: now.toISOString(),
      closedAt: null,
      workKey: workKey(work),
    };
    own.requests.push(request);
    return { status: 200, body: requestAnswer(request) };
  },
  "teacher.source-proof-request.delete": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    if (found === undefined || !found.canWrite) return { error: "not_found" };
    const open = keptOf(state).requests.find(
      (r) =>
        r.workKey === workKey(found.work) && r.sourceId === params.sourceId && r.closedAt === null,
    );
    if (open !== undefined) open.closedAt = now.toISOString();
    return { status: 204 };
  },
  "teacher.literature-seen.put": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    if (found === undefined || !found.canWrite) return { error: "not_found" };
    const seenAt = now.toISOString();
    keptOf(state).seen.set(workKey(found.work), seenAt);
    return { status: 200, body: { seenAt } };
  },
  "teacher.source-proofs.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    if (found === undefined) return { error: "not_found" };
    const { work } = found;
    if (
      !state.workSources.some(
        (s) =>
          s.assignmentId === work.assignmentId &&
          s.studentId === work.studentId &&
          s.id === params.sourceId.toLowerCase(),
      )
    ) {
      return { error: "not_found" };
    }
    const proofs = state.sourceProofs
      .filter(
        (p) =>
          p.assignmentId === work.assignmentId &&
          p.studentId === work.studentId &&
          p.sourceId === params.sourceId.toLowerCase(),
      )
      .map((p) => ({
        id: p.id,
        page: p.page,
        note: p.note,
        imagePath: `/api/v1/teacher/works/${work.documentId}/sources/${p.sourceId}/proofs/${p.id}/image`,
      }));
    return { status: 200, body: { proofs } };
  },
  "teacher.source-proof-image.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = workOf(state, account, params.documentId);
    const proof = state.sourceProofs.find(
      (p) =>
        found !== undefined &&
        p.assignmentId === found.work.assignmentId &&
        p.studentId === found.work.studentId &&
        p.sourceId === params.sourceId.toLowerCase() &&
        p.id === params.proofId.toLowerCase(),
    );
    if (proof === undefined) return { error: "not_found" };
    return {
      status: 200,
      headers: { "cache-control": "private, no-store" },
      body: new Blob([proof.image], { type: "image/jpeg" }),
    };
  },
  "teacher.course-literature.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = courseFor(state, account, params.courseId);
    if (found === undefined || found.role === "student") return { error: "not_found" };
    return {
      status: 200,
      body: { canWrite: found.role === "writer", sources: sourcesOf(state, found.course) as never },
    };
  },
  "teacher.course-literature.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const found = courseFor(state, account, params.courseId);
    if (found === undefined || found.role !== "writer") return { error: "not_found" };
    if (!Value.Check(WorkSourceRecord, body.record) || body.record.id !== params.sourceId) {
      return { error: "invalid_input" };
    }
    const own = keptOf(state);
    const list = own.literature.get(found.course.id) ?? [];
    const old = list.find((s) => s.id === params.sourceId);
    const doi = body.doi ?? null;
    const isbn = body.isbn ?? null;
    if (
      list.some(
        (s) =>
          s.id !== params.sourceId &&
          ((doi !== null && s.doi === doi) || (isbn !== null && s.isbn === isbn)),
      )
    ) {
      return { error: "conflict" };
    }
    if (old === undefined && list.length >= 200) return { error: "invalid_input" };
    const at = now.toISOString();
    const source: CourseSource = {
      id: params.sourceId,
      record: body.record,
      doi,
      isbn,
      undated: body.undated ?? false,
      createdAt: old?.createdAt ?? at,
      updatedAt: at,
    };
    own.literature.set(found.course.id, [...list.filter((s) => s !== old), source]);
    return { status: 200, body: source as never };
  },
  "teacher.course-literature.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = courseFor(state, account, params.courseId);
    if (found === undefined || found.role !== "writer") return { error: "not_found" };
    const own = keptOf(state);
    own.literature.set(
      found.course.id,
      (own.literature.get(found.course.id) ?? []).filter((s) => s.id !== params.sourceId),
    );
    return { status: 204 };
  },
  "student.course-literature.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const found = courseFor(state, account, params.courseId);
    if (found === undefined || found.role !== "student") return { error: "not_found" };
    return { status: 200, body: { sources: sourcesOf(state, found.course) as never } };
  },
  "student.source-proof-requests.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find(
      (w) => w.assignmentId === params.assignmentId.toLowerCase() && w.studentId === account.id,
    );
    if (work === undefined) return { error: "not_found" };
    const proofRequests = keptOf(state)
      .requests.filter((r) => r.workKey === workKey(work))
      .sort(byCreated)
      .map(requestAnswer);
    return { status: 200, body: { proofRequests } };
  },
};

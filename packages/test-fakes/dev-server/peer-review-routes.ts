// The anonymous peer review on the dev fake server (SRV-V19-RECENZIJA-UGOVOR):
// one round per assignment, allocated once among invented submitted works. The
// real rules are the database's (a later task). The fake treats the students
// of the course as having submitted and adds four invented ones, so the round
// reaches the least number of works; its allocation is a seeded ring (the
// seed is the roundId), so nobody reviews their own work and no two students
// review each other. The records live in a WeakMap keyed by state.assignments
// (a reset of the state replaces that array, so they go with it).
import { createHash, randomUUID } from "node:crypto";

import { peerReviewMinSubmissions } from "../../../server/contracts/index.ts";
import type { Operations } from "../../contracts/index.ts";
import type { Handlers } from "./server.ts";
import { teachesCourse, type Account, type Assignment, type State } from "./state.ts";

type Rubrics = Operations["peer-review.round.put"]["body"]["rubrics"];
type Round = {
  roundId: string;
  opensAt: string;
  dueAt: string;
  reviewsPerStudent: 1 | 2 | 3;
  rubrics: Rubrics;
  allocatedAt: string | null;
};
type Review = {
  reviewId: string;
  byRubric: { key: string; text: string }[];
  general: string | null;
  submittedAt: string;
  withdrawn: { reason: string; at: string } | null;
};
type Allocation = {
  taskId: string;
  reviewerId: string;
  authorId: string;
  review: Review | null;
};
type Entry = { round: Round | null; allocations: Allocation[] };

/** The invented id of the d-th task of a reviewer in an assignment, so a test can name it without the allocation. */
export const fakePeerTaskId = (assignmentId: string, reviewerId: string, d: number): string =>
  `7b000001-0000-4000-8000-${createHash("sha256").update(`${assignmentId}:${reviewerId}:${d}`).digest("hex").slice(0, 12)}`;
/** The invented id of the review written for a task. */
export const fakePeerReviewId = (taskId: string): string =>
  `7b000002-0000-4000-8000-${createHash("sha256").update(taskId).digest("hex").slice(0, 12)}`;

const ENTRIES = new WeakMap<object, Map<string, Entry>>();

/** Invented students whose work is submitted besides the course's own. */
const INVENTED = [1, 2, 3, 4].map((n) => ({
  id: `51000000-0000-4000-8000-00000000000${n}`,
  givenName: "Student",
  familyName: `Izmisljen ${n}`,
}));

function entryOf(state: State, assignmentId: string): Entry {
  let map = ENTRIES.get(state.assignments);
  if (map === undefined) {
    map = new Map();
    ENTRIES.set(state.assignments, map);
  }
  let entry = map.get(assignmentId);
  if (entry === undefined) {
    entry = { round: null, allocations: [] };
    map.set(assignmentId, entry);
  }
  return entry;
}

const courseOf = (state: State, assignment: Assignment) =>
  state.courses.find((c) => c.id === assignment.courseId);

/** The assignment of an id when the caller teaches its course. */
function taught(state: State, account: Account | null, id: string): Assignment | null {
  const assignment = state.assignments.find((a) => a.id === id.toLowerCase());
  const course = assignment === undefined ? undefined : courseOf(state, assignment);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account)
    ? assignment
    : null;
}

/** The assignment of an id when the caller is a student of its course. */
function enrolled(state: State, account: Account | null, id: string): Assignment | null {
  const assignment = state.assignments.find((a) => a.id === id.toLowerCase());
  const course = assignment === undefined ? undefined : courseOf(state, assignment);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    course.studentIds.includes(account.id)
    ? assignment
    : null;
}

const participantsOf = (state: State, assignment: Assignment): string[] =>
  [...(courseOf(state, assignment)?.studentIds ?? []), ...INVENTED.map((p) => p.id)].sort();

function person(state: State, id: string) {
  const known = state.accounts.find((a) => a.id === id) ?? INVENTED.find((p) => p.id === id);
  return {
    id,
    givenName: known?.givenName ?? "Student",
    familyName: known?.familyName ?? "Nepoznat",
  };
}

/** A seeded shuffle: the same roundId gives the same order. */
function shuffled(ids: readonly string[], seed: string): string[] {
  let h = createHash("sha256").update(seed).digest().readUInt32LE(0);
  const next = () => {
    h = (h + 0x6d2b79f5) | 0;
    let t = Math.imul(h ^ (h >>> 15), 1 | h);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function stateOf(
  round: Round | null,
  now: Date,
): Operations["peer-review.round.get"]["success"]["body"]["state"] {
  if (round === null) return "none";
  if (round.allocatedAt === null) return "not_allocated";
  const at = now.toISOString();
  return at < round.opensAt ? "allocated" : at < round.dueAt ? "open" : "closed";
}

/** The text of an invented work: it has no name in it, whoever wrote it. */
const blocksOf = (authorId: string) => [
  { kind: "heading" as const, text: "Izmisljen naslov rada" },
  {
    kind: "paragraph" as const,
    text: `Izmisljen odlomak ${createHash("sha256").update(authorId).digest("hex").slice(0, 4)} o izmisljenoj temi.`,
  },
];

const byPerson = (a: { familyName: string; givenName: string; id: string }, b: typeof a) =>
  a.familyName.localeCompare(b.familyName) ||
  a.givenName.localeCompare(b.givenName) ||
  a.id.localeCompare(b.id);

export const PEER_REVIEW_HANDLERS: Handlers = {
  "peer-review.round.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const entry = entryOf(state, assignment.id);
    if (entry.round?.allocatedAt != null) return { error: "already_allocated" };
    if (body.opensAt >= body.dueAt) return { error: "invalid_input" };
    if (new Set(body.rubrics.map((c) => c.key)).size !== body.rubrics.length) {
      return { error: "invalid_input" };
    }
    entry.round = {
      roundId: randomUUID(),
      opensAt: body.opensAt,
      dueAt: body.dueAt,
      reviewsPerStudent: body.reviewsPerStudent,
      rubrics: body.rubrics,
      allocatedAt: null,
    };
    return { status: 200, body: { round: { ...entry.round } } };
  },
  "peer-review.round.get": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const { round } = entryOf(state, assignment.id);
    return {
      status: 200,
      body: {
        round: round === null ? null : { ...round },
        state: stateOf(round, now),
        submittedWorks: participantsOf(state, assignment).length,
        minSubmissions: peerReviewMinSubmissions(round?.reviewsPerStudent ?? 1),
      },
    };
  },
  "peer-review.allocate.post": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const entry = entryOf(state, assignment.id);
    if (entry.round === null) return { error: "not_found" };
    if (entry.round.allocatedAt !== null) return { error: "already_allocated" };
    const ids = participantsOf(state, assignment);
    const k = entry.round.reviewsPerStudent;
    if (ids.length < peerReviewMinSubmissions(k)) return { error: "too_few_submissions" };
    const ring = shuffled(ids, entry.round.roundId);
    for (let i = 0; i < ring.length; i++) {
      for (let d = 1; d <= k; d++) {
        entry.allocations.push({
          taskId: fakePeerTaskId(assignment.id, ring[i]!, d),
          reviewerId: ring[i]!,
          authorId: ring[(i + d) % ring.length]!,
          review: null,
        });
      }
    }
    entry.round.allocatedAt = now.toISOString();
    return { status: 201, body: { allocated: entry.allocations.length } };
  },
  "peer-review.teacher-overview.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const rows = entryOf(state, assignment.id).allocations.map((a) => ({
      reviewId: a.review?.reviewId ?? null,
      reviewer: person(state, a.reviewerId),
      author: person(state, a.authorId),
      state:
        a.review === null
          ? ("pending" as const)
          : a.review.withdrawn === null
            ? ("submitted" as const)
            : ("withdrawn" as const),
    }));
    rows.sort((a, b) => byPerson(a.reviewer, b.reviewer) || byPerson(a.author, b.author));
    return { status: 200, body: { allocations: rows } };
  },
  "peer-review.review-withdrawal.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = taught(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const found = entryOf(state, assignment.id).allocations.find(
      (a) => a.review?.reviewId === params.reviewId.toLowerCase(),
    );
    if (found?.review == null) return { error: "not_found" };
    if (found.review.withdrawn !== null) return { error: "conflict" };
    found.review.withdrawn = { reason: body.reason, at: now.toISOString() };
    return { status: 201, body: { reviewId: found.review.reviewId } };
  },
  "student.peer-review-tasks.get": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = enrolled(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const { round, allocations } = entryOf(state, assignment.id);
    const at = now.toISOString();
    if (round === null || round.allocatedAt === null || at < round.opensAt) {
      return { status: 200, body: { state: "none", tasks: [] } };
    }
    const tasks = allocations
      .filter((a) => a.reviewerId === account.id)
      .map((a) => ({
        taskId: a.taskId,
        state: a.review === null ? ("pending" as const) : ("submitted" as const),
        dueAt: round.dueAt,
      }));
    if (tasks.length === 0) return { status: 200, body: { state: "none", tasks: [] } };
    return { status: 200, body: { state: at < round.dueAt ? "open" : "closed", tasks } };
  },
  "student.peer-review-work.get": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    for (const assignment of state.assignments) {
      const { round, allocations } = entryOf(state, assignment.id);
      const task = allocations.find(
        (a) => a.taskId === params.taskId.toLowerCase() && a.reviewerId === account.id,
      );
      const at = now.toISOString();
      if (task === undefined || round === null || at < round.opensAt || at >= round.dueAt) continue;
      return {
        status: 200,
        body: {
          rubrics: round.rubrics,
          document: { revision: 1, blocks: blocksOf(task.authorId) },
        },
      };
    }
    return { error: "not_found" };
  },
  "student.peer-review.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    for (const assignment of state.assignments) {
      const { round, allocations } = entryOf(state, assignment.id);
      const task = allocations.find(
        (a) => a.taskId === params.taskId.toLowerCase() && a.reviewerId === account.id,
      );
      if (task === undefined || round === null) continue;
      const at = now.toISOString();
      if (at < round.opensAt) return { error: "not_found" };
      if (at >= round.dueAt) return { error: "closed" };
      if (task.review !== null) return { error: "already_reviewed" };
      const sent = body.byRubric.map((c) => c.key).sort();
      const wanted = round.rubrics.map((c) => c.key).sort();
      if (sent.length !== wanted.length || sent.some((key, i) => key !== wanted[i])) {
        return { error: "invalid_input" };
      }
      task.review = {
        reviewId: fakePeerReviewId(task.taskId),
        byRubric: body.byRubric.map((c) => ({ key: c.key, text: c.text })),
        general: body.general ?? null,
        submittedAt: at,
        withdrawn: null,
      };
      return { status: 201, body: { reviewId: task.review.reviewId } };
    }
    return { error: "not_found" };
  },
  "student.peer-reviews-received.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignment = enrolled(state, account, params.assignmentId);
    if (assignment === null) return { error: "not_found" };
    const { round, allocations } = entryOf(state, assignment.id);
    const reviews = allocations
      .filter((a) => a.authorId === account.id && a.review !== null && a.review.withdrawn === null)
      .map((a) => a.review!)
      .sort(
        (x, y) =>
          x.submittedAt.localeCompare(y.submittedAt) || x.reviewId.localeCompare(y.reviewId),
      )
      .map((r) => ({
        reviewId: r.reviewId,
        byRubric: r.byRubric.map((c) => ({
          key: c.key,
          label: round?.rubrics.find((x) => x.key === c.key)?.label ?? c.key,
          text: c.text,
        })),
        general: r.general,
        submittedAt: r.submittedAt,
      }));
    return { status: 200, body: { reviews } };
  },
};

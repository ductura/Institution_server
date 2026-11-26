// SRV-V19-RECENZIJA-RUTE (Ductus#2055; val 19): the adapter of the peer review.
// Every call is one withActor transaction with the app.* RPCs of migration
// 20261219340000 (peer_review): the client never writes a table. Who may do what
// is decided by the RPCs from the relation (student enrolled, teacher of the
// course), never from a role alone; another's, an unknown and a malformed
// assignment, task or review all come back as ZD404. The allocation is the
// database's alone (seeded by the round id); nothing here allocates. A ZD409
// keeps its message (already_allocated, too_few_submissions, closed,
// already_reviewed, conflict): the route turns it into the reason it names.
import {
  anonymousBlocks,
  anonymousReview,
  anonymousRubrics,
  compareByName,
  type PeerReviewBlockRow,
  type PeerReviewReceivedRow,
} from "../../domain/index.ts";
import type { WithActor } from "../index.ts";

type RoundRow = {
  roundId: string | null;
  opensAt: Date | null;
  dueAt: Date | null;
  reviewsPerStudent: number | null;
  rubrics: unknown;
  allocatedAt: Date | null;
};
type RoundStateRow = RoundRow & { state: string; submittedWorks: number; minSubmissions: number };
type TaskRow = {
  roundState: string;
  taskId: string | null;
  taskState: string | null;
  dueAt: Date | null;
};
type WorkRow = PeerReviewBlockRow & { rubrics: unknown };
type OverviewRow = {
  reviewId: string | null;
  reviewerId: string;
  reviewerGivenName: string | null;
  reviewerFamilyName: string | null;
  authorId: string;
  authorGivenName: string | null;
  authorFamilyName: string | null;
  state: string;
};

const ROUND_COLUMNS = `round_id AS "roundId", opens_at AS "opensAt", due_at AS "dueAt",
  reviews_per_student AS "reviewsPerStudent", rubrics`;
const SET_ROUND = `SELECT ${ROUND_COLUMNS}, NULL::timestamptz AS "allocatedAt"
  FROM app.set_peer_review_round($1::uuid, $2::timestamptz, $3::timestamptz, $4::integer, $5::jsonb)`;
const GET_ROUND = `SELECT ${ROUND_COLUMNS}, allocated_at AS "allocatedAt", state,
  submitted_works AS "submittedWorks", min_submissions AS "minSubmissions"
  FROM app.peer_review_round($1::uuid)`;
const ALLOCATE = `SELECT app.allocate_peer_review($1::uuid) AS allocated`;
const OVERVIEW = `SELECT review_id AS "reviewId", reviewer_id AS "reviewerId",
  reviewer_given_name AS "reviewerGivenName", reviewer_family_name AS "reviewerFamilyName",
  author_id AS "authorId", author_given_name AS "authorGivenName",
  author_family_name AS "authorFamilyName", state
  FROM app.peer_review_overview($1::uuid)`;
const WITHDRAW = `SELECT app.withdraw_peer_review($1::uuid, $2::uuid, $3::text) AS "reviewId"`;
const TASKS = `SELECT round_state AS "roundState", task_id AS "taskId", task_state AS "taskState",
  due_at AS "dueAt" FROM app.peer_review_tasks($1::uuid)`;
const WORK = `SELECT rubrics, ord, kind, body FROM app.peer_review_work($1::uuid)`;
const ADD_REVIEW = `SELECT app.add_peer_review($1::uuid, $2::jsonb, $3::text) AS "reviewId"`;
const RECEIVED = `SELECT review_id AS "reviewId", by_rubric AS "byRubric", general,
  submitted_at AS "submittedAt" FROM app.peer_reviews_received($1::uuid)`;

const instant = (value: Date | null, what: string): string => {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`peer review ${what} without a time`);
  }
  return value.toISOString();
};

function roundOf(row: RoundRow) {
  if (row.roundId === null) return null;
  return {
    roundId: row.roundId,
    opensAt: instant(row.opensAt, "round"),
    dueAt: instant(row.dueAt, "round"),
    reviewsPerStudent: row.reviewsPerStudent,
    rubrics: anonymousRubrics(row.rubrics),
    allocatedAt: row.allocatedAt === null ? null : instant(row.allocatedAt, "allocation"),
  };
}

function personOf(id: string, givenName: string | null, familyName: string | null) {
  // A person without a name is a broken record, not an anonymous one: 503.
  if (givenName === null || familyName === null)
    throw new Error("peer review person without a name");
  return { id, givenName, familyName };
}

function one<T>(rows: readonly T[], what: string): T {
  if (rows.length !== 1 || rows[0] === undefined) throw new Error(`missing peer review ${what}`);
  return rows[0];
}

export function createPeerReviewStore(withActor: WithActor) {
  return {
    setRound: (
      token: string,
      assignmentId: string,
      input: {
        opensAt: string;
        dueAt: string;
        reviewsPerStudent: number;
        rubrics: readonly { key: string; label: string }[];
      },
    ) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<RoundRow>(SET_ROUND, [
          assignmentId,
          input.opensAt,
          input.dueAt,
          input.reviewsPerStudent,
          JSON.stringify(input.rubrics.map(({ key, label }) => ({ key, label }))),
        ]);
        return { round: roundOf(one(rows, "round")) };
      }),
    round: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const row = one((await tx.query<RoundStateRow>(GET_ROUND, [assignmentId])).rows, "round");
        return {
          round: roundOf(row),
          state: row.state,
          submittedWorks: row.submittedWorks,
          minSubmissions: row.minSubmissions,
        };
      }),
    allocate: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const row = one(
          (await tx.query<{ allocated: number }>(ALLOCATE, [assignmentId])).rows,
          "allocation",
        );
        return { allocated: row.allocated };
      }),
    overview: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<OverviewRow>(OVERVIEW, [assignmentId]);
        const allocations = rows.map((row) => ({
          reviewId: row.reviewId,
          reviewer: personOf(row.reviewerId, row.reviewerGivenName, row.reviewerFamilyName),
          author: personOf(row.authorId, row.authorGivenName, row.authorFamilyName),
          state: row.state,
        }));
        // The order of the names (reviewer, then author), never of an amount or a quality.
        allocations.sort(
          (a, b) => compareByName(a.reviewer, b.reviewer) || compareByName(a.author, b.author),
        );
        return { allocations };
      }),
    withdraw: (token: string, assignmentId: string, reviewId: string, reason: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<{ reviewId: string }>(WITHDRAW, [
          assignmentId,
          reviewId,
          reason,
        ]);
        return { reviewId: one(rows, "withdrawal").reviewId };
      }),
    tasks: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<TaskRow>(TASKS, [assignmentId]);
        const state = rows[0]?.roundState ?? "none";
        const tasks = rows
          .filter((row) => row.taskId !== null)
          .map((row) => ({
            taskId: row.taskId!,
            state: row.taskState,
            dueAt: instant(row.dueAt, "task"),
          }));
        return { state, tasks };
      }),
    work: (token: string, taskId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<WorkRow>(WORK, [taskId]);
        // Every row carries the same rubrics; a work with no block is one row with a null ord.
        const first = rows[0];
        if (first === undefined) throw new Error("missing peer review work");
        return {
          rubrics: anonymousRubrics(first.rubrics),
          document: { blocks: anonymousBlocks(rows) },
        };
      }),
    addReview: (
      token: string,
      taskId: string,
      input: { byRubric: readonly { key: string; text: string }[]; general?: string },
    ) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<{ reviewId: string }>(ADD_REVIEW, [
          taskId,
          JSON.stringify(input.byRubric.map(({ key, text }) => ({ key, text }))),
          input.general ?? null,
        ]);
        return { reviewId: one(rows, "review").reviewId };
      }),
    received: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<PeerReviewReceivedRow>(RECEIVED, [assignmentId]);
        return { reviews: rows.map(anonymousReview) };
      }),
  };
}

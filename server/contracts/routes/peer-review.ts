// SRV-V19-RECENZIJA-UGOVOR (Ductus#2055; val 19, docs/nalazi/val19-razlika.md
// §5 task 10): the contract of an anonymous peer review among students that the
// teacher opens and runs. The teacher sets one round per assignment (when it
// opens and closes, how many reviews each student writes, up to six rubrics),
// and allocates it once, deterministically, among the students who have
// submitted. A student then reads one allocated work without any trace of its
// author, writes one review of it by rubric, and later reads the reviews of
// their own work without any trace of the reviewer. The teacher sees both ends
// and may withdraw a review with a reason. Nothing here is a grade, a score or a
// rank, nothing enters a grade or its export, and nothing sanctions a student.
// Another's, an unknown and a malformed assignment, task or review all read the
// same 404 (C-23). The database (a later task) decides access; the contract only
// declares it. The text is in docs/contracts/peer-review-v1.md.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const Id = Type.String({ pattern: `^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}${END}` });
/**
 * A path id of a task or review: any non-empty text, so that a malformed one
 * reaches the handler and reads the same 404 as an unknown one (a pattern here
 * would answer it 422 before the handler runs, C-23). The body ids stay strict.
 */
const IdParam = Type.String({ minLength: 1, maxLength: 64 });
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d\\.\\d{3}Z${END}`,
});

/** Reviews each student writes: 1 to 3 (a closed list, so a validator needs no arithmetic). */
export const PEER_REVIEW_PER_STUDENT = [1, 2, 3] as const;
/** The most rubrics of a round. */
export const PEER_REVIEW_RUBRICS_MAX = 6;
/** The most allocations one overview lists (3 reviews each for 1000 students). */
export const PEER_REVIEW_ALLOCATIONS_MAX = 3000;
/** The most tasks one student has in a round (the most reviews per student). */
export const PEER_REVIEW_TASKS_MAX = 3;
/** The most blocks of the document a reviewer reads. */
export const PEER_REVIEW_BLOCKS_MAX = 2000;
/** The most code points of one block of that document. */
export const PEER_REVIEW_BLOCK_TEXT_MAX = 20_000;

/**
 * The fewest submitted works a round needs before it can be allocated (the
 * reviewer of a work must not be able to narrow its author down by who
 * reviews whom): never fewer than 5, and 2 * reviewsPerStudent + 1 so that an
 * allocation with no self-review and no pair of students reviewing each
 * other exists. An assumption of the contract (docs/contracts/peer-review-v1.md,
 * "Pretpostavke"); a lower number is a decision of the owner.
 */
export const PEER_REVIEW_MIN_SUBMISSIONS = 5;
export const peerReviewMinSubmissions = (reviewsPerStudent: number): number =>
  Math.max(PEER_REVIEW_MIN_SUBMISSIONS, 2 * reviewsPerStudent + 1);

/** The characters of a person's text that are never accepted: control (but newline and tab) and bidi controls. */
const BODY_CHAR = `[^\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\uD800-\\uDFFF]`;
/** A text of 1 to 4000 code points that is not blank (NFC is asked of the database too). */
const ReviewText = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|${BODY_CHAR}){1,4000}${END}`,
});
/** One line of 1 to 120 code points: the label of a rubric. */
const Label = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\u061c\\u200e\\u200f\\u202a-\\u202e\\u2066-\\u2069\\uD800-\\uDFFF]){1,120}(?<!\\s)${END}`,
});
/** A reason for a withdrawal: 1 to 600 code points, newline and tab allowed, not blank. */
const Reason = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|${BODY_CHAR}){1,600}${END}`,
});
/** A name of a person, one line (the teacher sees both ends of an allocation). */
const PersonName = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,100}(?<!\\s)${END}`,
});
/** The key of a rubric: a short word, unique within the round (the database checks that). */
const RubricKey = Type.String({ pattern: `^[a-z][a-z0-9-]{0,39}${END}` });

const PerStudent = Type.Union(PEER_REVIEW_PER_STUDENT.map((n) => Type.Literal(n)));
const Rubric = closed({ key: RubricKey, label: Label });
const Rubrics = Type.Array(Rubric, { minItems: 1, maxItems: PEER_REVIEW_RUBRICS_MAX });
const ByRubric = Type.Array(closed({ key: RubricKey, text: ReviewText }), {
  minItems: 1,
  maxItems: PEER_REVIEW_RUBRICS_MAX,
});
const Person = closed({ id: Id, givenName: PersonName, familyName: PersonName });

const AssignmentParams = closed({ assignmentId: Type.String({ minLength: 1 }) });
const ReviewParams = closed({ assignmentId: Type.String({ minLength: 1 }), reviewId: IdParam });
const TaskParams = closed({ taskId: IdParam });

const Round = closed({
  roundId: Id,
  opensAt: Instant,
  dueAt: Instant,
  reviewsPerStudent: PerStudent,
  rubrics: Rubrics,
  /** When the round was allocated, or null before. */
  allocatedAt: Type.Union([Instant, Type.Null()]),
});
/** Where a round is, as the teacher sees it. */
const TeacherState = Type.Union([
  Type.Literal("none"),
  Type.Literal("not_allocated"),
  Type.Literal("allocated"),
  Type.Literal("open"),
  Type.Literal("closed"),
]);
const TaskState = Type.Union([Type.Literal("pending"), Type.Literal("submitted")]);

/**
 * One block of the work a reviewer reads: its kind and its text, nothing else.
 * No attrs, marks, ids, authors, timestamps or other metadata of a block, so
 * none can name the author; the title page and the signature of the work are
 * not blocks of this answer at all (docs/contracts/peer-review-v1.md).
 */
const Block = closed({
  kind: Type.Union([
    Type.Literal("paragraph"),
    Type.Literal("heading"),
    Type.Literal("quote"),
    Type.Literal("list_item"),
  ]),
  text: Type.String({ maxLength: PEER_REVIEW_BLOCK_TEXT_MAX }),
});

const noStore = ["cache-control"];
const refusals = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  ...refusals,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
];

const TEACHER_PATH = "/api/v1/teacher/assignments/{assignmentId}/peer-review";
const STUDENT_PATH = "/api/v1/student/assignments/{assignmentId}/peer-review";

export const peerReviewRoundPut = defineRoute({
  id: "peer-review.round.put",
  method: "PUT",
  path: TEACHER_PATH,
  inventory: "app/api/teacher/assignments/[assignmentId]/peer-review/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the assignment sets its round of peer review: opensAt before dueAt, reviewsPerStudent 1 to 3 and 1 to 6 rubrics, each a key (a short lowercase word, unique in the round) and a one-line label of 1 to 120 code points. There is at most one round per assignment; setting it again replaces it only while it is not allocated, after that it is 409 already_allocated. opensAt not before dueAt and repeated keys are 422 invalid_input. No rubric is a grade or carries points. An inaccessible, unknown or malformed assignment reads 404.",
  request: {
    params: AssignmentParams,
    body: closed({
      opensAt: Instant,
      dueAt: Instant,
      reviewsPerStudent: PerStudent,
      rubrics: Rubrics,
    }),
    contentType: "application/json",
    maxBodyBytes: 8192,
  },
  responses: [
    {
      status: 200,
      description: "the round as set",
      body: closed({ round: Round }),
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "already_allocated")],
});

export const peerReviewRoundGet = defineRoute({
  id: "peer-review.round.get",
  method: "GET",
  path: TEACHER_PATH,
  inventory: "app/api/teacher/assignments/[assignmentId]/peer-review/route.ts",
  access: "course_teacher",
  summary:
    "The round of the assignment for its teacher, or null with state none. state is none, not_allocated, allocated (before opensAt), open or closed (after dueAt). submittedWorks counts the works of the assignment that are submitted and minSubmissions is the fewest a round needs to be allocated (never fewer than 5, and 2 * reviewsPerStudent + 1): it is there so the teacher sees why an allocation is refused, not to compare students. An inaccessible, unknown or malformed assignment reads 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the round, or null",
      body: closed({
        round: Type.Union([Round, Type.Null()]),
        state: TeacherState,
        submittedWorks: Type.Integer({ minimum: 0 }),
        minSubmissions: Type.Integer({ minimum: PEER_REVIEW_MIN_SUBMISSIONS }),
      }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const peerReviewAllocatePost = defineRoute({
  id: "peer-review.allocate.post",
  method: "POST",
  path: `${TEACHER_PATH}/allocations`,
  inventory: "app/api/teacher/assignments/[assignmentId]/peer-review/allocations/route.ts",
  access: "course_teacher",
  summary:
    "The teacher allocates the round once, with no body. The allocation is deterministic (the seed is the roundId, so the same round and the same submitted works give the same allocation) and only among students whose work is submitted: nobody reviews their own work, no two students review each other's, and everyone reviews and is reviewed exactly reviewsPerStudent times. Fewer submitted works than the round needs (see peer-review.round.get, minSubmissions) is 409 too_few_submissions, and nothing is allocated: with too few works a reviewer could work out the author of the work they read. A second allocation is 409 already_allocated; a round that does not exist reads 404. The answer is the number of allocations made.",
  request: { params: AssignmentParams, maxBodyBytes: 0 },
  responses: [
    {
      status: 201,
      description: "the number of allocations made",
      body: closed({
        allocated: Type.Integer({ minimum: 1, maximum: PEER_REVIEW_ALLOCATIONS_MAX }),
      }),
      headers: noStore,
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    ...refusals,
    error(409, "too_few_submissions"),
    error(409, "already_allocated"),
  ],
});

export const peerReviewTeacherOverviewGet = defineRoute({
  id: "peer-review.teacher-overview.get",
  method: "GET",
  path: `${TEACHER_PATH}/overview`,
  inventory: "app/api/teacher/assignments/[assignmentId]/peer-review/overview/route.ts",
  access: "course_teacher",
  summary:
    "The allocations of the round for its teacher, who sees both ends: reviewer and author by name. Ordered by reviewer's family name, given name, id, then author's the same way. reviewId is null while the review is pending and carries the id the withdrawal route takes otherwise. It is a list of facts: no score, no count per student, no order by quality. An inaccessible, unknown or malformed assignment reads 404; an assignment with no allocated round has no allocations.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the allocations, possibly none",
      body: closed({
        allocations: Type.Array(
          closed({
            reviewId: Type.Union([Id, Type.Null()]),
            reviewer: Person,
            author: Person,
            state: Type.Union([
              Type.Literal("pending"),
              Type.Literal("submitted"),
              Type.Literal("withdrawn"),
            ]),
          }),
          { maxItems: PEER_REVIEW_ALLOCATIONS_MAX },
        ),
      }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const peerReviewReviewWithdrawalPost = defineRoute({
  id: "peer-review.review-withdrawal.post",
  method: "POST",
  path: `${TEACHER_PATH}/reviews/{reviewId}/withdrawal`,
  inventory:
    "app/api/teacher/assignments/[assignmentId]/peer-review/reviews/[reviewId]/withdrawal/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the assignment withdraws a submitted review with a reason of 1 to 600 code points. The review is not deleted: it stays for the teacher and disappears from the answer of student.peer-reviews-received.get. A withdrawal is never undone; a review that is already withdrawn is 409 conflict, one that is still pending (not written) reads 404. Another's, an unknown and a malformed review all read 404.",
  request: {
    params: ReviewParams,
    body: closed({ reason: Reason }),
    contentType: "application/json",
    maxBodyBytes: 4096,
  },
  responses: [
    {
      status: 201,
      description: "the withdrawn review",
      body: closed({ reviewId: Id }),
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "conflict")],
});

export const studentPeerReviewTasksGet = defineRoute({
  id: "student.peer-review-tasks.get",
  method: "GET",
  path: `${STUDENT_PATH}/tasks`,
  inventory: "app/api/student/assignments/[assignmentId]/peer-review/tasks/route.ts",
  access: "student_enrolled",
  summary:
    "The reviews the student is to write in the round of an assignment of their course. state is disabled (the faculty has the review off), none (no round, or this student has no allocation: a work that was not submitted is not allocated), open (between opensAt and dueAt) or closed (after dueAt). A task is only its taskId, whether it is pending or submitted, and the deadline: nothing about the work or its author. The tasks of a round that is not yet open are not listed. It is not a count to compare, and a student who has written nothing has no mark. Another's, an unknown and a malformed assignment read 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the tasks, possibly none",
      body: closed({
        state: Type.Union([
          Type.Literal("disabled"),
          Type.Literal("none"),
          Type.Literal("open"),
          Type.Literal("closed"),
        ]),
        tasks: Type.Array(closed({ taskId: Id, state: TaskState, dueAt: Instant }), {
          maxItems: PEER_REVIEW_TASKS_MAX,
        }),
      }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const studentPeerReviewWorkGet = defineRoute({
  id: "student.peer-review-work.get",
  method: "GET",
  path: "/api/v1/student/peer-review/tasks/{taskId}/work",
  inventory: "app/api/student/peer-review/tasks/[taskId]/work/route.ts",
  access: "student",
  summary:
    "The submitted work the task is for, as its allocated reviewer reads it, and the rubrics to review it by. Anonymous: the answer has no field of any person, of the work, of the assignment or of the course, and the document is only the text of the submitted revision as blocks of a kind and a text: the title page, the signature and the metadata of the blocks (authors, timestamps, ids, marks) are not part of it. It is read only while the round is open and only by the student the task is allocated to; before opening, after the deadline, or by anyone else (the author included) it reads 404, the same as an unknown or malformed task. A text the author wrote about themselves in the body of the work is the author's own and is not looked for.",
  request: { params: TaskParams },
  responses: [
    {
      status: 200,
      description: "the rubrics and the anonymised work",
      body: closed({
        rubrics: Rubrics,
        document: closed({
          revision: Type.Integer({ minimum: 1 }),
          blocks: Type.Array(Block, { maxItems: PEER_REVIEW_BLOCKS_MAX }),
        }),
      }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const studentPeerReviewPost = defineRoute({
  id: "student.peer-review.post",
  method: "POST",
  path: "/api/v1/student/peer-review/tasks/{taskId}/review",
  inventory: "app/api/student/peer-review/tasks/[taskId]/review/route.ts",
  access: "student",
  summary:
    "The allocated reviewer writes the review of the task's work: one text of 1 to 4000 code points for each rubric of the round (exactly those keys, once each, else 422 invalid_input) and an optional general comment of up to 4000 code points. It is written once and only added: it cannot be changed or removed by the student. After the deadline it is 409 closed; a second one for the same task is 409 already_reviewed. A task that is not the caller's, an unknown or a malformed one reads 404, as does one of a round that is not yet open. There is no score and no rating.",
  request: {
    params: TaskParams,
    body: closed({ byRubric: ByRubric, general: Type.Optional(ReviewText) }),
    contentType: "application/json",
    // 7 texts of 4000 code points of 4 bytes each, plus keys and quotes.
    maxBodyBytes: 131_072,
  },
  responses: [
    {
      status: 201,
      description: "the written review",
      body: closed({ reviewId: Id }),
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "closed"), error(409, "already_reviewed")],
});

export const studentPeerReviewsReceivedGet = defineRoute({
  id: "student.peer-reviews-received.get",
  method: "GET",
  path: `${STUDENT_PATH}/received`,
  inventory: "app/api/student/assignments/[assignmentId]/peer-review/received/route.ts",
  access: "student_enrolled",
  summary:
    "The reviews of the caller's own work in the round, oldest first, then reviewId. Anonymous: no field of the reviewer, of the allocation or of the task, and a withdrawn review is not listed (the teacher keeps it). Each item carries the rubrics it answers by key and label (as the round had them) and the optional general comment. Nothing is summed, scored or ranked. Without a round, or with no review yet, the list is empty; another's, an unknown and a malformed assignment read 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the reviews, possibly none",
      body: closed({
        reviews: Type.Array(
          closed({
            reviewId: Id,
            byRubric: Type.Array(closed({ key: RubricKey, label: Label, text: ReviewText }), {
              minItems: 1,
              maxItems: PEER_REVIEW_RUBRICS_MAX,
            }),
            general: Type.Union([ReviewText, Type.Null()]),
            submittedAt: Instant,
          }),
          { maxItems: PEER_REVIEW_TASKS_MAX },
        ),
      }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const peerReviewRoutes = [
  peerReviewRoundPut,
  peerReviewRoundGet,
  peerReviewAllocatePost,
  peerReviewTeacherOverviewGet,
  peerReviewReviewWithdrawalPost,
  studentPeerReviewTasksGet,
  studentPeerReviewWorkGet,
  studentPeerReviewPost,
  studentPeerReviewsReceivedGet,
] as const;

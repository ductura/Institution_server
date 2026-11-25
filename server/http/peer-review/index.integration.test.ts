import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createPeerReviewRoutesFor } from "./index.ts";

// The routes over a scripted database: shape checks, the refusals of the RPCs
// and the reasons they become, the anonymous answers a student reads, and the
// text of a review kept out of every teacher answer and every log. Who may do
// what is the database's (db/main/tests/249-peer-review.sql). Everything here
// is invented.
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000020a1";
const ROUND = "00000000-0000-4000-8000-0000000020b1";
const TASK = "00000000-0000-4000-8000-0000000020c1";
const REVIEW = "00000000-0000-4000-8000-0000000020e1";
const REVIEWER = "00000000-0000-4000-8000-0000000020d1";
const AUTHOR = "00000000-0000-4000-8000-0000000020d2";
const WORK = "00000000-0000-4000-8000-0000000020f1";
const SECRET_TEXT = "Izmišljeni tekst recenzije koji nastavnik ne čita.";
const query = vi.fn<(sql: string, values?: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      expect(token).toBe(TOKEN);
      const rows = sql.includes("identity.touch_current_session") ? [] : query(sql, values);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);
const refuse = (code: string, message = "refused") => Object.assign(new Error(message), { code });

let running: Running;
beforeAll(async () => {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createPeerReviewRoutesFor({ withActor }),
  });
});
afterAll(async () => {
  await running.close();
});
beforeEach(() => {
  query.mockReset();
});

function call(
  path: string,
  options: { method?: string; body?: unknown; cookie?: string; contentType?: string } = {},
) {
  const { method = options.body === undefined ? "GET" : "POST", body, cookie = TOKEN } = options;
  return fetch(`http://127.0.0.1:${running.port}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `__Host-ductus_session=${cookie}` } : {}),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": options.contentType ?? "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const problem = async (response: Response) => ({
  status: response.status,
  code: ((await response.json()) as { code: string }).code,
});
const TEACHER = `/api/v1/teacher/assignments/${ASSIGNMENT}/peer-review`;
const STUDENT = `/api/v1/student/assignments/${ASSIGNMENT.toUpperCase()}/peer-review`;
const TASK_PATH = `/api/v1/student/peer-review/tasks/${TASK}`;
const ROUND_BODY = {
  opensAt: "2026-12-01T08:00:00.000Z",
  dueAt: "2026-12-08T08:00:00.000Z",
  reviewsPerStudent: 2,
  rubrics: [{ key: "clarity", label: "Jasnoća" }],
};
const REVIEW_BODY = { byRubric: [{ key: "clarity", text: SECRET_TEXT }], general: SECRET_TEXT };

it("answers a missing session with 401 and never reads the database", async () => {
  for (const path of [TEACHER, `${TEACHER}/overview`, `${STUDENT}/tasks`, `${TASK_PATH}/work`]) {
    expect((await call(path, { cookie: "" })).status).toBe(401);
  }
  expect((await call(`${TASK_PATH}/review`, { body: REVIEW_BODY, cookie: "" })).status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

it("reads a malformed assignment, task or review in the path as the same 404, without the database", async () => {
  for (const path of [
    "/api/v1/teacher/assignments/not-an-id/peer-review",
    "/api/v1/student/assignments/not-an-id/peer-review/received",
    "/api/v1/student/peer-review/tasks/not-an-id/work",
  ]) {
    expect(await problem(await call(path))).toEqual({ status: 404, code: "not_found" });
  }
  expect(
    await problem(
      await call(`${TEACHER}/reviews/not-an-id/withdrawal`, { body: { reason: "Razlog." } }),
    ),
  ).toEqual({ status: 404, code: "not_found" });
  expect(
    await problem(
      await call("/api/v1/student/peer-review/tasks/not-an-id/review", { body: REVIEW_BODY }),
    ),
  ).toEqual({ status: 404, code: "not_found" });
  expect(query).not.toHaveBeenCalled();
});

it("refuses a bad body before the database", async () => {
  expect(
    (await call(`${TASK_PATH}/review`, { body: REVIEW_BODY, contentType: "text/plain" })).status,
  ).toBe(415);
  for (const bad of [
    {},
    { byRubric: [] },
    { byRubric: [{ key: "Clarity", text: "x" }] },
    { ...REVIEW_BODY, extra: 1 },
  ]) {
    expect(await problem(await call(`${TASK_PATH}/review`, { body: bad }))).toEqual({
      status: 422,
      code: "invalid_input",
    });
  }
  expect(
    await problem(
      await call(TEACHER, { method: "PUT", body: { ...ROUND_BODY, reviewsPerStudent: 4 } }),
    ),
  ).toEqual({ status: 422, code: "invalid_input" });
  expect(query).not.toHaveBeenCalled();
});

it("turns each ZD409 into the reason its route declares, and an undeclared one into 503", async () => {
  const refusing = (message: string) =>
    query.mockImplementation(() => {
      throw refuse("ZD409", message);
    });
  refusing("too_few_submissions");
  expect(await problem(await call(`${TEACHER}/allocations`, { method: "POST" }))).toEqual({
    status: 409,
    code: "too_few_submissions",
  });
  refusing("already_allocated");
  expect(await problem(await call(`${TEACHER}/allocations`, { method: "POST" }))).toEqual({
    status: 409,
    code: "already_allocated",
  });
  expect(await problem(await call(TEACHER, { method: "PUT", body: ROUND_BODY }))).toEqual({
    status: 409,
    code: "already_allocated",
  });
  refusing("closed");
  expect(await problem(await call(`${TASK_PATH}/review`, { body: REVIEW_BODY }))).toEqual({
    status: 409,
    code: "closed",
  });
  refusing("already_reviewed");
  expect(await problem(await call(`${TASK_PATH}/review`, { body: REVIEW_BODY }))).toEqual({
    status: 409,
    code: "already_reviewed",
  });
  refusing("conflict");
  expect(
    await problem(
      await call(`${TEACHER}/reviews/${REVIEW}/withdrawal`, { body: { reason: "Razlog." } }),
    ),
  ).toEqual({ status: 409, code: "conflict" });
  // A reason the route does not declare is a failure, not a conflict under another name.
  refusing("closed");
  expect(await problem(await call(`${TEACHER}/allocations`, { method: "POST" }))).toEqual({
    status: 503,
    code: "unavailable",
  });
  query.mockImplementation(() => {
    throw refuse("ZD404");
  });
  expect(await problem(await call(`${TASK_PATH}/work`))).toEqual({
    status: 404,
    code: "not_found",
  });
  query.mockImplementation(() => {
    throw refuse("ZD422");
  });
  expect(await problem(await call(TEACHER, { method: "PUT", body: ROUND_BODY }))).toEqual({
    status: 422,
    code: "invalid_input",
  });
});

it("gives the work a reviewer reads without any identifier of a person, work or task", async () => {
  query.mockImplementation((sql, values) => {
    expect(sql).toContain("app.peer_review_work");
    expect(values).toEqual([TASK]);
    const leak = { reviewerId: REVIEWER, authorId: AUTHOR, submissionId: WORK, taskId: TASK };
    return [
      {
        rubrics: [{ key: "clarity", label: "Jasnoća", by: AUTHOR }],
        ord: 2,
        kind: "paragraph",
        body: "Odlomak.",
        ...leak,
      },
      {
        rubrics: [{ key: "clarity", label: "Jasnoća", by: AUTHOR }],
        ord: 1,
        kind: "heading",
        body: "Naslov",
        ...leak,
      },
    ];
  });
  const response = await call(`${TASK_PATH}/work`);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    rubrics: [{ key: "clarity", label: "Jasnoća" }],
    document: {
      blocks: [
        { kind: "heading", text: "Naslov" },
        { kind: "paragraph", text: "Odlomak." },
      ],
    },
  });
  for (const id of [REVIEWER, AUTHOR, WORK, TASK]) expect(text).not.toContain(id);
});

it("gives a work with no block as an empty document", async () => {
  query.mockImplementation(() => [
    { rubrics: [{ key: "a", label: "A" }], ord: null, kind: null, body: null },
  ]);
  expect(await (await call(`${TASK_PATH}/work`)).json()).toEqual({
    rubrics: [{ key: "a", label: "A" }],
    document: { blocks: [] },
  });
});

it("gives the received reviews without the reviewer, the work or the task", async () => {
  query.mockImplementation((sql) => {
    expect(sql).toContain("app.peer_reviews_received");
    return [
      {
        reviewId: REVIEW,
        byRubric: [{ key: "clarity", label: "Jasnoća", text: "Jasno.", reviewer: REVIEWER }],
        general: null,
        submittedAt: new Date("2026-12-02T10:00:00Z"),
        reviewerId: REVIEWER,
        taskId: TASK,
        submissionId: WORK,
      },
    ];
  });
  const response = await call(`${STUDENT}/received`);
  expect(response.status).toBe(200);
  const text = await response.text();
  expect(JSON.parse(text)).toEqual({
    reviews: [
      {
        reviewId: REVIEW,
        byRubric: [{ key: "clarity", label: "Jasnoća", text: "Jasno." }],
        general: null,
        submittedAt: "2026-12-02T10:00:00.000Z",
      },
    ],
  });
  for (const id of [REVIEWER, AUTHOR, WORK, TASK]) expect(text).not.toContain(id);
});

it("gives the tasks of a student, and none when there is no round", async () => {
  query.mockImplementation(() => [
    {
      roundState: "open",
      taskId: TASK,
      taskState: "pending",
      dueAt: new Date("2026-12-08T08:00:00Z"),
    },
  ]);
  expect(await (await call(`${STUDENT}/tasks`)).json()).toEqual({
    state: "open",
    tasks: [{ taskId: TASK, state: "pending", dueAt: "2026-12-08T08:00:00.000Z" }],
  });
  query.mockImplementation(() => [
    { roundState: "none", taskId: null, taskState: null, dueAt: null },
  ]);
  expect(await (await call(`${STUDENT}/tasks`)).json()).toEqual({ state: "none", tasks: [] });
});

it("gives the teacher the round, the allocation count and the overview in the order of the names, without any review text", async () => {
  query.mockImplementation((sql) => {
    if (sql.includes("app.peer_review_round")) {
      return [
        {
          roundId: ROUND,
          opensAt: new Date("2026-12-01T08:00:00Z"),
          dueAt: new Date("2026-12-08T08:00:00Z"),
          reviewsPerStudent: 2,
          rubrics: [{ key: "clarity", label: "Jasnoća" }],
          allocatedAt: null,
          state: "not_allocated",
          submittedWorks: 6,
          minSubmissions: 5,
        },
      ];
    }
    if (sql.includes("app.allocate_peer_review")) return [{ allocated: 12 }];
    if (sql.includes("app.peer_review_overview")) {
      return [
        {
          reviewId: REVIEW,
          reviewerId: REVIEWER,
          reviewerGivenName: "Ivo",
          reviewerFamilyName: "Zorić",
          authorId: AUTHOR,
          authorGivenName: "Ana",
          authorFamilyName: "Babić",
          state: "submitted",
          text: SECRET_TEXT,
        },
        {
          reviewId: null,
          reviewerId: AUTHOR,
          reviewerGivenName: "Ana",
          reviewerFamilyName: "Babić",
          authorId: REVIEWER,
          authorGivenName: "Ivo",
          authorFamilyName: "Zorić",
          state: "pending",
          general: SECRET_TEXT,
        },
      ];
    }
    throw new Error(`unexpected ${sql}`);
  });
  expect(await (await call(TEACHER)).json()).toEqual({
    round: { roundId: ROUND, ...ROUND_BODY, allocatedAt: null },
    state: "not_allocated",
    submittedWorks: 6,
    minSubmissions: 5,
  });
  const allocated = await call(`${TEACHER}/allocations`, { method: "POST" });
  expect(allocated.status).toBe(201);
  expect(await allocated.json()).toEqual({ allocated: 12 });
  const overview = await call(`${TEACHER}/overview`);
  const text = await overview.text();
  expect(JSON.parse(text)).toEqual({
    allocations: [
      {
        reviewId: null,
        reviewer: { id: AUTHOR, givenName: "Ana", familyName: "Babić" },
        author: { id: REVIEWER, givenName: "Ivo", familyName: "Zorić" },
        state: "pending",
      },
      {
        reviewId: REVIEW,
        reviewer: { id: REVIEWER, givenName: "Ivo", familyName: "Zorić" },
        author: { id: AUTHOR, givenName: "Ana", familyName: "Babić" },
        state: "submitted",
      },
    ],
  });
  expect(text).not.toContain(SECRET_TEXT);
});

it("sets a round and writes a review through the RPCs, and logs no review text when one fails", async () => {
  query.mockImplementation((sql, values) => {
    if (sql.includes("app.set_peer_review_round")) {
      expect(values).toEqual([
        ASSIGNMENT,
        ROUND_BODY.opensAt,
        ROUND_BODY.dueAt,
        2,
        JSON.stringify(ROUND_BODY.rubrics),
      ]);
      return [
        {
          roundId: ROUND,
          opensAt: new Date(ROUND_BODY.opensAt),
          dueAt: new Date(ROUND_BODY.dueAt),
          reviewsPerStudent: 2,
          rubrics: ROUND_BODY.rubrics,
          allocatedAt: null,
        },
      ];
    }
    expect(sql).toContain("app.add_peer_review");
    expect(values).toEqual([TASK, JSON.stringify(REVIEW_BODY.byRubric), SECRET_TEXT]);
    return [{ reviewId: REVIEW }];
  });
  const put = await call(TEACHER, { method: "PUT", body: ROUND_BODY });
  expect(put.status).toBe(200);
  expect(await put.json()).toEqual({ round: { roundId: ROUND, ...ROUND_BODY, allocatedAt: null } });
  const added = await call(`${TASK_PATH}/review`, { body: REVIEW_BODY });
  expect(added.status).toBe(201);
  expect(await added.json()).toEqual({ reviewId: REVIEW });

  const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
  try {
    query.mockImplementation(() => {
      throw new Error(`insert failed: ${SECRET_TEXT}`);
    });
    expect(await problem(await call(`${TASK_PATH}/review`, { body: REVIEW_BODY }))).toEqual({
      status: 503,
      code: "unavailable",
    });
    expect(logged).toHaveBeenCalled();
    expect(JSON.stringify(logged.mock.calls)).not.toContain(SECRET_TEXT);
  } finally {
    logged.mockRestore();
  }
});

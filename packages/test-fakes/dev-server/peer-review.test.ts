// SRV-V19-RECENZIJA-UGOVOR on the dev fake server: the allocation has nobody
// reviewing their own work and no two reviewing each other, too few works
// refuse it, the work the reviewer reads names no one, only the allocated
// reviewer reads it, a closed round takes no review and a reset takes the
// records with it.
import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { fakePeerTaskId } from "./peer-review-routes.ts";
import { send, signIn } from "./testing.ts";

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const ROUND = `/api/v1/teacher/assignments/${IDS.assignment}/peer-review`;
const HOUR = 3_600_000;
const round = (reviewsPerStudent: number, from: number, to: number) => ({
  opensAt: new Date(Date.now() + from * HOUR).toISOString(),
  dueAt: new Date(Date.now() + to * HOUR).toISOString(),
  reviewsPerStudent,
  rubrics: [{ key: "argument", label: "Jasnoca argumenta" }],
});

async function setup(reviewsPerStudent: number, from = -1, to = 24) {
  const state = createState();
  const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
  const student = { ...(await signIn(state, "student")), ...ORIGIN };
  const other = { ...(await signIn(state, "student-2")), ...ORIGIN };
  const put = await send(state, ROUND, {
    method: "PUT",
    headers: teacher,
    body: round(reviewsPerStudent, from, to),
  });
  expect(put.status).toBe(200);
  const allocate = () => send(state, `${ROUND}/allocations`, { method: "POST", headers: teacher });
  return { state, teacher, student, other, allocate };
}

type Row = { reviewer: { id: string }; author: { id: string }; reviewId: string | null };

describe("peer review", () => {
  it.each([1, 2])("allocates %i reviews each: no self, no pair, even load", async (k) => {
    const { state, teacher, allocate } = await setup(k);
    expect((await allocate()).status).toBe(201);
    const overview = await send(state, `${ROUND}/overview`, { headers: teacher });
    const rows = (overview.json as { allocations: Row[] }).allocations;
    expect(rows).toHaveLength(5 * k);
    const pair = new Set(rows.map((r) => `${r.reviewer.id}>${r.author.id}`));
    for (const r of rows) {
      expect(r.reviewer.id).not.toBe(r.author.id);
      expect(pair.has(`${r.author.id}>${r.reviewer.id}`)).toBe(false);
    }
    for (const id of new Set(rows.map((r) => r.reviewer.id))) {
      expect(rows.filter((r) => r.reviewer.id === id)).toHaveLength(k);
      expect(rows.filter((r) => r.author.id === id)).toHaveLength(k);
    }
  });

  it("refuses too few works, allocates nothing and lets the round be set again", async () => {
    const { state, teacher, allocate } = await setup(3);
    const refused = await allocate();
    expect(refused.status).toBe(409);
    expect(refused.json).toMatchObject({ code: "too_few_submissions" });
    const get = await send(state, ROUND, { headers: teacher });
    expect(get.json).toMatchObject({
      state: "not_allocated",
      submittedWorks: 5,
      minSubmissions: 7,
    });
    expect(
      (await send(state, ROUND, { method: "PUT", headers: teacher, body: round(1, -1, 24) }))
        .status,
    ).toBe(200);
    expect((await allocate()).status).toBe(201);
    expect((await allocate()).json).toMatchObject({ code: "already_allocated" });
    const again = await send(state, ROUND, {
      method: "PUT",
      headers: teacher,
      body: round(1, -1, 24),
    });
    expect(again.json).toMatchObject({ code: "already_allocated" });
  });

  it("shows the reviewer a work with no name, id or metadata, and only to them", async () => {
    const { state, student, other, teacher, allocate } = await setup(1);
    await allocate();
    const task = fakePeerTaskId(IDS.assignment, IDS.student, 1);
    const work = await send(state, `/api/v1/student/peer-review/tasks/${task}/work`, {
      headers: student,
    });
    expect(work.status).toBe(200);
    const text = JSON.stringify(work.json);
    expect(text).not.toMatch(/Izmisljen \d|Student|[0-9a-f]{8}-[0-9a-f]{4}-/);
    const keys = new Set<string>();
    JSON.stringify(work.json, (key, value) => (keys.add(key), value));
    expect(keys.has("author") || keys.has("authorId") || keys.has("givenName")).toBe(false);
    // another student, the teacher and a task nobody has all read 404
    for (const headers of [other, teacher]) {
      const read = await send(state, `/api/v1/student/peer-review/tasks/${task}/work`, { headers });
      expect(read.status).toBe(404);
    }
    const none = await send(
      state,
      `/api/v1/student/peer-review/tasks/${fakePeerTaskId(IDS.assignment, IDS.student, 2)}/work`,
      { headers: student },
    );
    expect(none.status).toBe(404);
  });

  it("takes one review per task, with exactly the rubrics of the round", async () => {
    const { state, student, allocate } = await setup(1);
    await allocate();
    const path = `/api/v1/student/peer-review/tasks/${fakePeerTaskId(IDS.assignment, IDS.student, 1)}/review`;
    const post = (body: unknown) => send(state, path, { method: "POST", headers: student, body });
    expect((await post({ byRubric: [{ key: "izvori", text: "Izmisljeno." }] })).status).toBe(422);
    expect(
      (
        await post({
          byRubric: [
            { key: "argument", text: "Jedan." },
            { key: "argument", text: "Dva." },
          ],
        })
      ).status,
    ).toBe(422);
    expect((await post({ byRubric: [{ key: "argument", text: "Izmisljeno." }] })).status).toBe(201);
    const second = await post({ byRubric: [{ key: "argument", text: "Drugo." }] });
    expect(second.json).toMatchObject({ code: "already_reviewed" });
    const tasks = await send(
      state,
      `/api/v1/student/assignments/${IDS.assignment}/peer-review/tasks`,
      {
        headers: student,
      },
    );
    expect(tasks.json).toMatchObject({ state: "open", tasks: [{ state: "submitted" }] });
  });

  it("takes no review after the deadline and shows no tasks before the opening", async () => {
    const closed = await setup(1, -3, -1);
    await closed.allocate();
    const path = `/api/v1/student/peer-review/tasks/${fakePeerTaskId(IDS.assignment, IDS.student, 1)}`;
    const late = await send(closed.state, `${path}/review`, {
      method: "POST",
      headers: closed.student,
      body: { byRubric: [{ key: "argument", text: "Kasno." }] },
    });
    expect(late.json).toMatchObject({ code: "closed" });
    expect((await send(closed.state, `${path}/work`, { headers: closed.student })).status).toBe(
      404,
    );
    const soon = await setup(1, 2, 24);
    await soon.allocate();
    const tasks = await send(
      soon.state,
      `/api/v1/student/assignments/${IDS.assignment}/peer-review/tasks`,
      {
        headers: soon.student,
      },
    );
    expect(tasks.json).toEqual({ state: "none", tasks: [] });
  });

  it("forgets the round on a reset", async () => {
    const { state } = await setup(1);
    Object.assign(state, createState());
    const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
    const get = await send(state, ROUND, { headers: teacher });
    expect(get.json).toMatchObject({ round: null, state: "none" });
  });
});

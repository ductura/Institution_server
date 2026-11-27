// F4-PM2-R08-SRV on the dev fake server: a state reset (as /__lazni/ponovno
// does it, by Object.assign) clears the accommodation mark, and a submission
// withdrawn since still locks it (409), as app.work_submission_requested does.
import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { send, signIn } from "./testing.ts";

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const PATH = `/api/v1/student/assignments/${IDS.assignment}/accommodation`;

describe("work accommodation mark", () => {
  it("forgets the mark on reset", async () => {
    const state = createState();
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const put = await send(state, PATH, {
      method: "PUT",
      headers: student,
      body: { marked: true },
    });
    expect(put.json).toEqual({ marked: true });
    Object.assign(state, createState());
    const again = { ...(await signIn(state, "student")), ...ORIGIN };
    expect((await send(state, PATH, { headers: again })).json).toEqual({ marked: false });
  });

  it("stays locked after a withdrawn submission", async () => {
    const state = createState();
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const account = state.accounts.find((a) => a.key === "student");
    state.submissionWithdrawals.push({
      assignmentId: IDS.assignment,
      studentId: account!.id,
    } as (typeof state.submissionWithdrawals)[number]);
    const put = await send(state, PATH, {
      method: "PUT",
      headers: student,
      body: { marked: true },
    });
    expect(put.status).toBe(409);
  });
});

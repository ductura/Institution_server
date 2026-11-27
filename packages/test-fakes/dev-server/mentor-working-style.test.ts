// F4-MEN-R09-SRV on the dev fake server: only the mentor writes, only the
// mentor's student reads, and a state reset (as /__lazni/ponovno does it, by
// Object.assign) takes the text with it.
import { describe, expect, it } from "vitest";

import { createState } from "./index.ts";
import { send, signIn } from "./testing.ts";

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };

describe("mentor working style", () => {
  it("is written by the mentor, read by the student, and forgotten on reset", async () => {
    const state = createState();
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
    const mentorId = state.mentorships[0]!.mentorId;
    const path = `/api/v1/student/mentors/${mentorId}/working-style`;
    const put = (headers: typeof teacher) =>
      send(state, "/api/v1/teacher/mentor-working-style", {
        method: "PUT",
        headers,
        body: { text: "Izmisljeni nacin rada." },
      });
    expect((await put(student)).status).toBe(403);
    expect((await put(teacher)).status).toBe(200);
    expect((await send(state, path, { headers: student })).json).toMatchObject({
      text: "Izmisljeni nacin rada.",
    });
    expect((await send(state, path, { headers: teacher })).status).toBe(404);
    Object.assign(state, createState());
    const again = { ...(await signIn(state, "student")), ...ORIGIN };
    expect((await send(state, path, { headers: again })).json).toEqual({
      text: null,
      updatedAt: null,
    });
  });
});

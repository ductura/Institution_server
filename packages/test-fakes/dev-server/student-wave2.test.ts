import { describe, expect, it } from "vitest";

import { CODES, createState, IDS } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

// SRV-02: the outcomes of student.enrollments.post (A-2) and the notice read
// mark (PO-7) on the dev fake server. All values are invented.
describe("dev fake server: student routes of wave 2", () => {
  const url = "/api/v1/student/enrollments";

  it("tells every enrolment outcome apart", async () => {
    const state = createState();
    const headers = await signIn(state, "student-2");
    const answers = [];
    for (const code of [CODES.valid, CODES.valid, CODES.emptyCourse, CODES.expired, "NEPOSTOJI1"])
      answers.push(await send(state, url, { body: { code }, headers }));
    for (const answer of answers.filter((a) => a.status === 200))
      expect(contractProblems("student.enrollments.post", answer)).toEqual([]);
    expect(answers.map((a) => [a.status, a.json])).toEqual([
      [200, { outcome: "enrolled", courseId: IDS.course }],
      [200, { outcome: "already_enrolled", courseId: IDS.course }],
      [200, { outcome: "enrolled_no_assignment", courseId: IDS.emptyCourse }],
      // STARI2025KOD belongs to the seminar, where student-2 is now enrolled.
      [200, { outcome: "already_enrolled", courseId: IDS.course }],
      [422, expect.objectContaining({ error: "invalid_code" })],
    ]);
  });

  it("an expired code of a course the student is not in is expired_code", async () => {
    const state = createState();
    const headers = await signIn(state, "student-2");
    const answer = await send(state, url, { body: { code: CODES.expired }, headers });
    expect([answer.status, (answer.json as { error: string }).error]).toEqual([
      422,
      "expired_code",
    ]);
  });

  it("marks the notice read once; another's assignment is 404", async () => {
    const state = createState();
    const path = `/api/v1/student/assignments/${IDS.assignment}/notice-read`;
    const own = await signIn(state, "student");
    const first = await send(state, path, { body: { versionNo: 1 }, headers: own });
    expect(contractProblems("student.notice-read.post", first)).toEqual([]);
    const again = await send(state, path, { body: { versionNo: 1 }, headers: own });
    expect(again.json).toEqual(first.json);
    expect((await send(state, path, { body: { versionNo: 2 }, headers: own })).status).toBe(409);
    const other = await signIn(state, "student-2");
    expect((await send(state, path, { body: { versionNo: 1 }, headers: other })).status).toBe(404);
  });
});

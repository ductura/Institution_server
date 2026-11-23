// SRV-MENTOR-3 on the dev fake server: the note to self is the owner's alone,
// a mark keeps its first instant and the teacher sees what the student opened,
// and the mentor's overview counts the student's unopened messages. Invented
// texts only.
import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const SELF_NOTE = `/api/v1/works/${IDS.document}/self-note`;
const PLACE = { nodeId: "1f0e2d3c-4b5a-4968-8776-655443322110", offset: 7 };

describe("note to self", () => {
  it("is kept for the owner and is 404 for the teacher", async () => {
    const state = createState();
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
    const put = await send(state, SELF_NOTE, {
      method: "PUT",
      headers: student,
      body: { text: "Izmišljena bilješka.", place: PLACE },
    });
    expect(contractProblems("work.self-note.put", put)).toEqual([]);
    expect(put.json).toMatchObject({ note: { text: "Izmišljena bilješka.", place: PLACE } });
    expect((await send(state, SELF_NOTE, { headers: teacher })).status).toBe(404);
    const reading = await send(state, `/api/v1/works/${IDS.document}/reading-place`, {
      method: "PUT",
      headers: student,
      body: { place: PLACE },
    });
    expect(reading.json).toMatchObject({
      note: { text: "Izmišljena bilješka." },
      readingPlace: { place: PLACE },
    });
    const deleted = await send(state, SELF_NOTE, { method: "DELETE", headers: student });
    expect(deleted.json).toMatchObject({ note: null, readingPlace: { place: PLACE } });
  });
});

describe("seen marks and the overview", () => {
  it("counts the student's unopened messages until the mentor opens them", async () => {
    const state = createState();
    state.mentorships[0]!.documentId = IDS.document;
    const student = { ...(await signIn(state, "student")), ...ORIGIN };
    const teacher = { ...(await signIn(state, "nastavnik")), ...ORIGIN };
    const messages = `/api/v1/works/${IDS.document}/messages`;
    const fromStudent = await send(state, messages, {
      headers: student,
      body: { text: "Izmišljeno pitanje." },
    });
    const fromTeacher = await send(state, messages, {
      headers: teacher,
      body: { text: "Izmišljen odgovor." },
    });
    const overview = async () =>
      (await send(state, "/api/v1/teacher/mentorship-overview", { headers: teacher })).json as {
        students: { newMessages: number; waitingOn: string }[];
      };
    expect((await overview()).students[0]).toMatchObject({ newMessages: 1, waitingOn: "mentor" });

    const seen = `/api/v1/works/${IDS.document}/seen`;
    const studentId = (fromStudent.json as { id: string }).id;
    const teacherId = (fromTeacher.json as { id: string }).id;
    const marked = await send(state, seen, {
      headers: teacher,
      body: {
        items: [
          { kind: "message", id: studentId },
          { kind: "message", id: teacherId },
        ],
      },
    });
    expect((marked.json as { items: { id: string }[] }).items.map((m) => m.id)).toEqual([
      studentId,
    ]);
    expect((await overview()).students[0]).toMatchObject({ newMessages: 0, waitingOn: "student" });

    const byStudent = `/api/v1/works/${IDS.document}/seen-by-student`;
    expect((await send(state, byStudent, { headers: teacher })).json).toEqual({ items: [] });
    const first = await send(state, seen, {
      headers: student,
      body: { items: [{ kind: "message", id: teacherId }] },
    });
    const again = await send(state, seen, {
      headers: student,
      body: { items: [{ kind: "message", id: teacherId }] },
    });
    expect(again.json).toEqual(first.json);
    expect((await send(state, byStudent, { headers: teacher })).json).toEqual(first.json);
    expect((await send(state, byStudent, { headers: student })).json).toEqual({ items: [] });
  });
});

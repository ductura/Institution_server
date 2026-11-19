import { describe, expect, it } from "vitest";

import { createState, IDS } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

// UGOVORI-API on the dev fake server: the student's notice, the teacher's
// current version with the creation's groups, outside tools and summary-only
// mode, and the state of the enrolment code. All values are invented.
const CONTENT = {
  title: "Izmišljeni naslov",
  instructions: "Izmišljene upute.",
  workType: "essay",
  opensAt: "2026-10-01T06:00:00Z",
  dueAt: "2027-01-31T22:59:00Z",
  aiPolicy: "partially_allowed",
  aiPurposes: [],
  evidenceProfile: "basic",
  importAllowed: false,
  wordMin: null,
  wordMax: 2500,
};
const C = `/api/v1/institution/courses/${IDS.course}`;

describe("dev fake server: contracts ahead of their handlers", () => {
  it("the student reads the notice of the current version; another student does not", async () => {
    const state = createState();
    const url = `/api/v1/student/assignments/${IDS.assignment}/notice`;
    const notice = await send(state, url, { headers: await signIn(state, "student") });
    expect(contractProblems("student.notice.get", notice)).toEqual([]);
    expect(notice.json).toMatchObject({ versionNo: 1, acknowledgedAt: expect.any(String) });
    expect((await send(state, url, { headers: await signIn(state, "student-2") })).status).toBe(
      404,
    );
  });

  it("a creation with groups, outside tools and summary only reads back in the current version", async () => {
    const state = createState();
    const teacher = await signIn(state, "nastavnik");
    const body = {
      requestKey: "c26f7081-92a3-4b5c-9d6e-7f8091a2b301",
      ...CONTENT,
      groupIds: [IDS.groupA.toUpperCase()],
      externalToolsAllowed: true,
      aiSummaryOnly: true,
    };
    const made = await send(state, `${C}/assignments`, { body, headers: teacher });
    expect(made.status).toBe(201);
    const url = `/api/v1/institution/assignments/${(made.json as { id: string }).id}`;
    const current = await send(state, url, { headers: teacher });
    expect(contractProblems("institution.assignment.get", current)).toEqual([]);
    expect(current.json).toMatchObject({
      versionNo: 1,
      groupIds: [IDS.groupA],
      externalToolsAllowed: true,
      aiSummaryOnly: true,
    });
    expect((await send(state, url, { headers: await signIn(state, "student") })).status).toBe(404);
  });

  it.each([
    ["a group of another course", { groupIds: ["00000000-0000-4000-8000-0000000000aa"] }],
    ["a group named twice", { groupIds: [IDS.groupA, IDS.groupA] }],
    ["summary only under a prohibited policy", { aiPolicy: "prohibited", aiSummaryOnly: true }],
    ["summary only with a purpose", { aiPurposes: ["proofreading"], aiSummaryOnly: true }],
  ])("refuses %s with 422", async (_name, change) => {
    const state = createState();
    const body = { requestKey: "c26f7081-92a3-4b5c-9d6e-7f8091a2b302", ...CONTENT, ...change };
    const headers = await signIn(state, "nastavnik");
    expect((await send(state, `${C}/assignments`, { body, headers })).status).toBe(422);
  });

  it("the code's state survives a reload: issued, then none once revoked, never the code", async () => {
    const state = createState();
    const teacher = await signIn(state, "nastavnik");
    const url = `${C}/enrollment-code/state`;
    const validUntil = "2027-03-01T10:00:00.000Z";
    await send(state, `${C}/enrollment-code`, { body: { validUntil }, headers: teacher });
    const issued = await send(state, url, { headers: teacher });
    expect(contractProblems("institution.enrollment-code-state.get", issued)).toEqual([]);
    expect(issued.json).toEqual({ current: { validUntil } });
    await send(state, `${C}/enrollment-code/revocation`, { body: {}, headers: teacher });
    expect((await send(state, url, { headers: teacher })).json).toEqual({ current: null });
    expect((await send(state, url, { headers: await signIn(state, "student") })).status).toBe(404);
  });
});

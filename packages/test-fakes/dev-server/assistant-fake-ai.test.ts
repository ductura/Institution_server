import { afterEach, describe, expect, it, vi } from "vitest";

import { FAKE_AI_ENV } from "../assistant/index.ts";
import { createState, IDS } from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

const PATH = "/api/v1/student/assistant/requests";
const KEY = { "idempotency-key": "5f0c3a9e-2b7d-4c1e-9a6f-0d8e7b4c2a11" };

function body(paragraph: string) {
  return {
    assignmentId: IDS.assignment,
    conversationId: null,
    purposeCatalogVersion: 1,
    purposeKey: "proofreading",
    paragraph,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dev fake server: assistant with the fake local AI (SRV-FAKE-AI-LOKALNO)", () => {
  it("stays ai_disabled without the explicit switch", async () => {
    const state = createState();
    const headers = { ...(await signIn(state, "student")), ...KEY };
    const res = await send(state, PATH, { body: body("Izmišljeni odlomak."), headers });
    expect(res.json).toMatchObject({ outcome: "ai_disabled", requestId: null });
  });

  it("answers completed with the switch, and keeps the contract", async () => {
    vi.stubEnv(FAKE_AI_ENV, "1");
    const state = createState();
    const headers = { ...(await signIn(state, "student")), ...KEY };
    const res = await send(state, PATH, { body: body("Izmišljeni odlomak."), headers });
    expect(res.json).toMatchObject({ outcome: "completed" });
    expect(contractProblems("student.assistant-request.post", res)).toEqual([]);
    const refused = await send(state, PATH, { body: body("#odbij odlomak"), headers });
    expect(refused.json).toMatchObject({ outcome: "provider_failed" });
    expect(contractProblems("student.assistant-request.post", refused)).toEqual([]);
    const timedOut = await send(state, PATH, { body: body("#istek odlomak"), headers });
    expect(timedOut.json).toMatchObject({ outcome: "request_outcome_unknown" });
  });

  it("is forbidden for a teacher and for an unknown assignment", async () => {
    vi.stubEnv(FAKE_AI_ENV, "1");
    const state = createState();
    const teacher = { ...(await signIn(state, "nastavnik")), ...KEY };
    const asTeacher = await send(state, PATH, {
      body: body("Izmišljeni odlomak."),
      headers: teacher,
    });
    expect(asTeacher.json).toMatchObject({ outcome: "forbidden" });
    const student = { ...(await signIn(state, "student")), ...KEY };
    const unknown = await send(state, PATH, {
      body: {
        ...body("Izmišljeni odlomak."),
        assignmentId: "00000000-0000-4000-8000-0000000000ff",
      },
      headers: student,
    });
    expect(unknown.json).toMatchObject({ outcome: "forbidden" });
  });
});

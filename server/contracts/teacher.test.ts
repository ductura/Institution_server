// DAN-803 teacher contracts: the parts of the Ductus shape (078c780) that the
// schema itself must hold, beyond "every vector matches its schema".
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { validateInput } from "./generated/index.ts";
import { ROUTES } from "./index.ts";

const success = (id: string) => {
  const route = ROUTES.find((r) => r.id === id);
  if (route?.responses[0]?.body === undefined) throw new Error(`no success body for ${id}`);
  return route.responses[0].body;
};

describe("teacher.mentorship.get", () => {
  it("every success vector answers the mentorship it asks for (readMentoredWork)", () => {
    const vectors = VECTORS.filter(
      (v) => v.route === "teacher.mentorship.get" && v.response.status === 200,
    );
    expect(vectors.length).toBeGreaterThanOrEqual(2);
    for (const v of vectors) {
      const work = (v.response.body as { work: { mentorshipId: string } }).work;
      expect(work.mentorshipId, v.name).toBe(v.request.params?.["mentorshipId"]);
    }
  });

  it("a submitted or started work has a document, a work not started has none", () => {
    const body = success("teacher.mentorship.get");
    const work = {
      mentorshipId: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2901",
      assignmentId: "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01",
      documentId: "izmisljeni-rad-0001",
      student: null,
      title: "Izmišljeni rad",
      workType: "master_thesis",
      workState: "submitted",
    };
    expect(Value.Check(body, { work })).toBe(true);
    expect(Value.Check(body, { work: { ...work, documentId: null } })).toBe(false);
    expect(
      Value.Check(body, { work: { ...work, workState: "in_progress", documentId: null } }),
    ).toBe(false);
    expect(Value.Check(body, { work: { ...work, workState: "not_started" } })).toBe(false);
    expect(
      Value.Check(body, { work: { ...work, workState: "not_started", documentId: null } }),
    ).toBe(true);
  });
});

describe("teacher.fast-path.post", () => {
  it("takes exactly one UUID in any case; anything else is 422 at the server", () => {
    const id = "teacher.fast-path.post";
    expect(
      validateInput(id, "body", { assignmentId: "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01" }),
    ).toBe(true);
    expect(
      validateInput(id, "body", { assignmentId: "3A1B2C3D-4E5F-4A6B-8C7D-9E0F1A2B3C01" }),
    ).toBe(true);
    expect(validateInput(id, "body", { assignmentId: "nije-uuid" })).toBe(false);
    expect(validateInput(id, "body", { assignmentId: "" })).toBe(false);
    expect(
      validateInput(id, "body", {
        assignmentId: "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01",
        role: "x",
      }),
    ).toBe(false);
  });

  it("names a student by both names or by neither, never one alone", () => {
    const body = success("teacher.fast-path.post");
    const student = {
      id: "5e4d3c2b-1a09-4f8e-8d7c-6b5a4f3e2d02",
      givenName: "Izmišljena",
      surname: "Anić",
      documentId: null,
      work: "notice_pending",
      lastChangeAt: null,
      record: null,
    };
    const answer = (s: object) => ({ kind: "ok", students: [s] });
    expect(Value.Check(body, answer(student))).toBe(true);
    expect(Value.Check(body, answer({ ...student, givenName: null, surname: null }))).toBe(true);
    expect(Value.Check(body, answer({ ...student, givenName: null }))).toBe(false);
    expect(Value.Check(body, answer({ ...student, surname: null }))).toBe(false);
    expect(Value.Check(body, answer({ ...student, work: "writing" }))).toBe(false);
  });
});

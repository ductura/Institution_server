// DAN-803 teacher contracts: the parts of the Ductus shape (078c780) that the
// schema itself must hold, beyond "every vector matches its schema".
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { validateInput } from "./generated/index.ts";
import { isWorkId, ROUTES } from "./index.ts";

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

describe("work id and name patterns hold the Ductus rules exactly", () => {
  const work = (documentId: unknown) =>
    Value.Check(success("teacher.mentorship.get"), {
      work: {
        mentorshipId: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2901",
        assignmentId: "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01",
        documentId,
        student: null,
        title: "Izmišljeni rad",
        workType: "master_thesis",
        workState: "in_progress",
      },
    });
  const named = (givenName: string) =>
    Value.Check(success("teacher.mentorship.get"), {
      work: {
        mentorshipId: "7f6e5d4c-3b2a-4190-8f7e-6d5c4b3a2901",
        assignmentId: "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01",
        documentId: null,
        student: { givenName, familyName: "Anić" },
        title: "Izmišljeni rad",
        workType: "master_thesis",
        workState: "not_started",
      },
    });
  const astral = "\u{1D4D0}";

  it.each([
    "rad",
    "a b",
    "x".repeat(256),
    astral.repeat(256),
    "č".repeat(256),
    "'; DROP --",
    "rad\n",
    "rad ",
    " rad",
    " rad",
    "rad\u0000",
    "ra\u0085d",
    "ra\u007fd",
    "",
    "x".repeat(257),
    astral.repeat(257),
    "\ud800rad",
  ])("%j is a work id exactly when isWorkId says so", (id) => {
    expect(work(id)).toBe(isWorkId(id));
  });

  it("a name is 1 to 255 code points (isName)", () => {
    expect(named("x".repeat(255))).toBe(true);
    expect(named(astral.repeat(255))).toBe(true);
    expect(named("x".repeat(256))).toBe(false);
    expect(named(astral.repeat(256))).toBe(false);
    expect(named("")).toBe(false);
    expect(named("Ana\n")).toBe(true);
  });
});

// DAN-903-2: teacherPageRead as a route (Ductus#1836 c.6948165042).
describe("teacher.access.get", () => {
  const scope = "a".repeat(64);
  const check = (body: unknown) => Value.Check(success("teacher.access.get"), body);

  it("is exactly allowed or denied, with the principal scope of the same snapshot", () => {
    expect(check({ access: "allowed", scope })).toBe(true);
    expect(check({ access: "denied", scope })).toBe(true);
    expect(check({ access: "allowed" })).toBe(false);
    expect(check({ scope })).toBe(false);
  });

  it.each(["signedOut", "unavailable", "Allowed", "", "expired"])(
    "%j is no answer of 200 (401, 503 or nothing)",
    (access) => expect(check({ access, scope })).toBe(false),
  );

  it.each([
    "A".repeat(64),
    "a".repeat(63),
    "a".repeat(65),
    `${"a".repeat(64)}\n`,
    `${"a".repeat(64)}\r\n`,
    `${"a".repeat(64)}\t`,
    `${"a".repeat(64)} `,
    `${"a".repeat(64)}\u007f`,
    `${"a".repeat(63)}g`,
  ])("refuses the scope %j", (bad) => expect(check({ access: "denied", scope: bad })).toBe(false));

  it("names no course, role or count: any other key is refused", () => {
    for (const key of ["role", "courses", "toString"])
      expect(check({ access: "allowed", scope, [key]: [] }), key).toBe(false);
    expect(check(JSON.parse(`{"access":"allowed","scope":"${scope}","__proto__":{}}`))).toBe(false);
  });

  it("refuses only as a read: 401, 403 cross-site and 503, never 404", () => {
    const route = ROUTES.find((r) => r.id === "teacher.access.get");
    expect(route?.errors.map((e) => `${e.status} ${e.code}`)).toEqual([
      "401 unauthorized",
      "403 forbidden",
      "503 unavailable",
    ]);
  });
});

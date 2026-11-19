// The assignment port (SRV-14) over a fake withActor: the statement and its
// parameters in the RPC's order, every refusal by SQLSTATE, and a row of the
// wrong form as unavailable. The port never throws. All values are invented.
import { describe, expect, it } from "vitest";

import { type AssignmentContent, createInstitutionAssignments } from "./institution-assignments.ts";
import type { WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-nositelja-0000000000000001";
const COURSE = "7e1a2b3c-4d5e-4f60-8a71-b2c3d4e5f601";
const KEY = "b15e6f70-8192-4da4-8eb5-f60718293a05";
const ID = "a04d5e6f-7081-4c93-9da4-e5f607182904";
const CONTENT: AssignmentContent = {
  title: "Izmišljeni zadatak",
  instructions: "Izmišljene upute.",
  workType: "seminar_paper",
  opensAt: "2026-10-01T08:00:00+02:00",
  dueAt: "2027-01-31T23:59:00+01:00",
  aiPolicy: "partially_allowed",
  aiPurposes: ["proofreading"],
  evidenceProfile: "basic",
  importAllowed: false,
  wordMin: null,
  wordMax: 2500,
};
const VALUES = [
  ...["Izmišljeni zadatak", "Izmišljene upute.", "seminar_paper", CONTENT.opensAt, CONTENT.dueAt],
  ...["partially_allowed", ["proofreading"], "basic", false, null, 2500],
];

const seen: { token: unknown; text: string; values: readonly unknown[] }[] = [];
const answering =
  (rows: unknown[]): WithActor =>
  async (token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        seen.push({ token, text, values });
        return { rows: rows as never[], rowCount: rows.length };
      },
    });
const failing =
  (code: string): WithActor =>
  async () => {
    throw Object.assign(new Error("refused"), { code });
  };

describe("createAssignment", () => {
  it("calls create_assignment with the course, the key and the content; the id in lower case", async () => {
    seen.length = 0;
    const port = createInstitutionAssignments(answering([{ id: ID.toUpperCase() }]));
    expect(await port.createAssignment(TOKEN, COURSE, KEY, CONTENT)).toEqual({
      status: "created",
      id: ID,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.token).toBe(TOKEN);
    expect(seen[0]!.text).toContain("institution.create_assignment(");
    expect(seen[0]!.values).toEqual([COURSE, KEY, ...VALUES]);
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "forbidden"],
    ["ZD409", "conflict"],
    ["ZD422", "invalid"],
  ])("%s is %s", async (code, status) => {
    const port = createInstitutionAssignments(failing(code));
    expect(await port.createAssignment(TOKEN, COURSE, KEY, CONTENT)).toEqual({ status });
  });

  it.each([
    ["another SQLSTATE", failing("08006"), "database_error"],
    ["two rows", answering([{ id: ID }, { id: ID }]), "create_assignment_malformed"],
    ["an id that is not a UUID", answering([{ id: "x" }]), "create_assignment_malformed"],
  ])("%s is unavailable", async (_name, withActor, reason) => {
    const port = createInstitutionAssignments(withActor);
    expect(await port.createAssignment(TOKEN, COURSE, KEY, CONTENT)).toEqual({
      status: "unavailable",
      reason,
    });
  });
});

describe("publishVersion", () => {
  it("calls publish_assignment_version with the expected version; answers exactly the next", async () => {
    seen.length = 0;
    const port = createInstitutionAssignments(answering([{ version_no: 3 }]));
    expect(await port.publishVersion(TOKEN, ID, 2, CONTENT)).toEqual({
      status: "published",
      versionNo: 3,
    });
    expect(seen[0]!.text).toContain("institution.publish_assignment_version(");
    expect(seen[0]!.values).toEqual([ID, 2, ...VALUES]);
  });

  it("ZD409 is version_conflict; a version other than the next is unavailable", async () => {
    expect(
      await createInstitutionAssignments(failing("ZD409")).publishVersion(TOKEN, ID, 2, CONTENT),
    ).toEqual({ status: "version_conflict" });
    expect(
      await createInstitutionAssignments(answering([{ version_no: 4 }])).publishVersion(
        TOKEN,
        ID,
        2,
        CONTENT,
      ),
    ).toEqual({ status: "unavailable", reason: "publish_malformed" });
  });
});

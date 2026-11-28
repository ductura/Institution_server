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
/** The rows for every statement but the read of the links, which finds none. */
const answering =
  (rows: unknown[]): WithActor =>
  async (token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        seen.push({ token, text, values });
        const answer = text.includes("institution.assignment_groups(") ? [] : rows;
        return { rows: answer as never[], rowCount: answer.length };
      },
    });
const failing =
  (code: string): WithActor =>
  async () => {
    throw Object.assign(new Error("refused"), { code });
  };

describe("createAssignment", () => {
  it("calls create_assignment_with_groups with the course, the key and the content; the id in lower case", async () => {
    seen.length = 0;
    const port = createInstitutionAssignments(answering([{ id: ID.toUpperCase() }]));
    expect(await port.createAssignment(TOKEN, COURSE, KEY, CONTENT)).toEqual({
      status: "created",
      id: ID,
    });
    expect(seen).toHaveLength(2);
    expect(seen[0]!.token).toBe(TOKEN);
    expect(seen[0]!.text).toContain("institution.create_assignment_with_groups(");
    expect(seen[0]!.values).toEqual([COURSE, KEY, ...VALUES, false, false, false, []]);
    expect(seen[1]!.text).toBe("SELECT group_id FROM institution.assignment_groups($1::uuid)");
    expect(seen[1]!.values).toEqual([ID]);
  });

  it("passes practice and both setup rules after the content, in the RPC's order", async () => {
    seen.length = 0;
    const port = createInstitutionAssignments(answering([{ id: ID }]));
    const setup = { externalToolsAllowed: true, aiSummaryOnly: false };
    expect(await port.createAssignment(TOKEN, COURSE, KEY, CONTENT, true, setup)).toEqual({
      status: "created",
      id: ID,
    });
    expect(seen[0]!.text).toMatch(
      /\$14::boolean,\s+\$15::boolean, \$16::boolean, \$17::uuid\[\]\s+\) AS id/,
    );
    expect(seen[0]!.values).toEqual([COURSE, KEY, ...VALUES, true, true, false, []]);
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

// F4 wave 2 #5 (1.8): the groups in the creation's transaction.
describe("createAssignment with groups", () => {
  const GROUP_A = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d01";
  const GROUP_B = "5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d02";
  const SETUP = { externalToolsAllowed: false, aiSummaryOnly: false };
  /** One answer per statement, in order; a thrown answer is a refusal of that statement. */
  const scripted = (answers: (unknown[] | Error)[]) => {
    const texts: { text: string; values: readonly unknown[] }[] = [];
    let rolledBack = false;
    const withActor: WithActor = async (_token, fn) => {
      try {
        return await fn({
          query: async (text: string, values: readonly unknown[] = []) => {
            texts.push({ text, values });
            const answer = answers[texts.length - 1] ?? [];
            if (answer instanceof Error) throw answer;
            return { rows: answer as never[], rowCount: answer.length };
          },
        });
      } catch (thrown) {
        rolledBack = true;
        throw thrown;
      }
    };
    return { withActor, texts, rolledBack: () => rolledBack };
  };
  const refusal = (code: string) => Object.assign(new Error("refused"), { code });

  it("creates with the groups in one statement and reads the links back in the same transaction", async () => {
    const db = scripted([[{ id: ID }], [{ group_id: GROUP_B }, { group_id: GROUP_A }]]);
    const port = createInstitutionAssignments(db.withActor);
    expect(
      await port.createAssignment(TOKEN, COURSE, KEY, CONTENT, false, SETUP, [GROUP_A, GROUP_B]),
    ).toEqual({ status: "created", id: ID });
    expect(db.texts.map((t) => t.text)).toEqual([
      expect.stringContaining("institution.create_assignment_with_groups("),
      "SELECT group_id FROM institution.assignment_groups($1::uuid)",
    ]);
    expect(db.texts[0]!.values.at(-1)).toEqual([GROUP_A, GROUP_B]);
    expect(db.texts[1]!.values).toEqual([ID]);
    expect(db.rolledBack()).toBe(false);
  });

  it("no groups is the whole course: an empty list, and no link read back", async () => {
    const db = scripted([[{ id: ID }], []]);
    const port = createInstitutionAssignments(db.withActor);
    expect(await port.createAssignment(TOKEN, COURSE, KEY, CONTENT, false, SETUP, [])).toEqual({
      status: "created",
      id: ID,
    });
    expect(db.texts[0]!.values.at(-1)).toEqual([]);
    expect(db.rolledBack()).toBe(false);
  });

  it.each([
    ["a group of another course (ZD422) is invalid", "ZD422", "invalid"],
    ["a replay of the key with another set (ZD409) is conflict", "ZD409", "conflict"],
  ])("%s, and nothing is written", async (_name, code, status) => {
    const db = scripted([refusal(code)]);
    const port = createInstitutionAssignments(db.withActor);
    expect(
      await port.createAssignment(TOKEN, COURSE, KEY, CONTENT, false, SETUP, [GROUP_A]),
    ).toEqual({ status });
    expect(db.texts).toHaveLength(1);
    expect(db.rolledBack()).toBe(true);
  });

  // SRV#977 review: a replay that answered the id while another set is linked
  // is the key's conflict, whichever way the set differs.
  it.each([
    ["fewer groups", [GROUP_A], [{ group_id: GROUP_A }, { group_id: GROUP_B }]],
    ["other groups", [GROUP_A], [{ group_id: GROUP_B }]],
    ["more groups", [GROUP_A, GROUP_B], [{ group_id: GROUP_A }]],
    ["groups for the whole course", [GROUP_A], []],
    ["the whole course for groups", [], [{ group_id: GROUP_A }]],
  ])("a replay with %s is conflict and rolls back", async (_name, asked, linked) => {
    const db = scripted([[{ id: ID }], linked]);
    const port = createInstitutionAssignments(db.withActor);
    expect(await port.createAssignment(TOKEN, COURSE, KEY, CONTENT, false, SETUP, asked)).toEqual({
      status: "conflict",
    });
    expect(db.rolledBack()).toBe(true);
  });

  it("a link row of the wrong form is unavailable and rolls back", async () => {
    const db = scripted([[{ id: ID }], [{ group_id: "x" }]]);
    const port = createInstitutionAssignments(db.withActor);
    expect(
      await port.createAssignment(TOKEN, COURSE, KEY, CONTENT, false, SETUP, [GROUP_A]),
    ).toEqual({ status: "unavailable", reason: "create_assignment_malformed" });
    expect(db.rolledBack()).toBe(true);
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

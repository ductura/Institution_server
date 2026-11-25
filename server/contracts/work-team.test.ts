// SRV-V19-GRUPA-UGOVOR: the closed inputs of work teams and the shape of the
// contribution. Bad and edge input is refused by the schema itself; the vectors
// cover the answers.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "./index.ts";
import {
  institutionAssignmentTeamSettingPut,
  studentWorkTeamContributionGet,
  studentWorkTeamPost,
  teacherWorkTeamContributionGet,
  teacherWorkTeamMemberPost,
  WORK_TEAM_CATEGORIES,
  WORK_TEAM_NOTICE,
  workTeamRoutes,
} from "./routes/index.ts";

const ID = "00000000-0000-4000-8000-00000000b301";
const setting = { enabled: true, minSize: 2, maxSize: 4, formation: "student_choice" };
const okSetting = (body: unknown) =>
  Value.Check(institutionAssignmentTeamSettingPut.request.body!, body);

const members = (count: number) =>
  Array.from({ length: count }, (_, at) => ({
    givenName: "Student",
    familyName: `Probni${at}`,
    categories: WORK_TEAM_CATEGORIES.map((category) => ({ category, codePoints: 0 })),
    totalCodePoints: 0,
  }));
const okContribution = (body: unknown) =>
  Value.Check(studentWorkTeamContributionGet.responses[0]!.body!, body);

/** Every key name used anywhere inside a schema or value. */
function keysOf(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const item of value) keysOf(item, into);
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      into.add(key);
      keysOf(inner, into);
    }
  }
  return into;
}

describe("work team contract", () => {
  it("has nine routes and the two contribution routes share one body", () => {
    expect(workTeamRoutes.map((r) => r.id)).toEqual([
      "institution.assignment-team-setting.put",
      "institution.assignment-team-setting.get",
      "student.work-team.get",
      "student.work-team.post",
      "teacher.work-teams.get",
      "teacher.work-teams.post",
      "teacher.work-team-member.post",
      "student.work-team-contribution.get",
      "teacher.work-team-contribution.get",
    ]);
    expect(JSON.stringify(teacherWorkTeamContributionGet.responses[0]!.body)).toBe(
      JSON.stringify(studentWorkTeamContributionGet.responses[0]!.body),
    );
  });

  it("accepts a valid setting and refuses sizes outside 2 to 6, an unknown formation and extra fields", () => {
    expect(okSetting(setting)).toBe(true);
    expect(okSetting({ ...setting, minSize: 6, maxSize: 6 })).toBe(true);
    expect(okSetting({ ...setting, minSize: 1 })).toBe(false);
    expect(okSetting({ ...setting, maxSize: 7 })).toBe(false);
    expect(okSetting({ ...setting, minSize: 2.5 })).toBe(false);
    expect(okSetting({ ...setting, formation: "random" })).toBe(false);
    expect(okSetting({ ...setting, extra: 1 })).toBe(false);
    expect(okSetting({ enabled: true, minSize: 2, maxSize: 4 })).toBe(false);
  });

  it("takes join only with a team id and create and leave only without one", () => {
    const post = (body: unknown) => Value.Check(studentWorkTeamPost.request.body!, body);
    expect(post({ action: "create" })).toBe(true);
    expect(post({ action: "leave" })).toBe(true);
    expect(post({ action: "join", teamId: ID })).toBe(true);
    expect(post({ action: "join" })).toBe(false);
    expect(post({ action: "join", teamId: "nije-id" })).toBe(false);
    expect(post({ action: "create", teamId: ID })).toBe(false);
    expect(post({ action: "delete" })).toBe(false);
  });

  it("takes only add and remove with a student id from the teacher", () => {
    const body = (value: unknown) => Value.Check(teacherWorkTeamMemberPost.request.body!, value);
    expect(body({ studentId: ID, action: "add" })).toBe(true);
    expect(body({ studentId: ID, action: "remove" })).toBe(true);
    expect(body({ studentId: ID, action: "swap" })).toBe(false);
    expect(body({ studentId: "x", action: "add" })).toBe(false);
  });

  it("accepts a ready contribution only with the notice and the five categories in order", () => {
    const ready = { state: "ready", members: members(2), notice: WORK_TEAM_NOTICE };
    expect(okContribution(ready)).toBe(true);
    expect(okContribution({ ...ready, notice: undefined })).toBe(false);
    expect(okContribution({ state: "ready", members: members(2) })).toBe(false);
    expect(okContribution({ ...ready, members: members(7) })).toBe(false);
    expect(okContribution({ ...ready, members: [] })).toBe(false);
    const short = members(1);
    short[0]!.categories = short[0]!.categories.slice(1);
    expect(okContribution({ ...ready, members: short })).toBe(false);
    for (const state of ["disabled", "none", "pending", "failed"]) {
      expect(okContribution({ state })).toBe(true);
      expect(okContribution({ state, reason: "x" })).toBe(false);
    }
  });

  it("has no share, percent, rank, comparison, average, threshold or level in the contribution", () => {
    const forbidden =
      /share|percent|rank|order|compar|average|mean|threshold|level|score|high|low|colou?r/iu;
    const keys = keysOf(
      JSON.parse(JSON.stringify(studentWorkTeamContributionGet.responses[0]!.body)),
    );
    for (const key of ["properties", "required", "anyOf", "type", "const", "minItems"])
      keys.delete(key);
    const named = [...keys].filter((key) => forbidden.test(key));
    expect(named).toEqual([]);
  });

  it("is carried by no route besides the two contribution routes", () => {
    const own = new Set([
      "student.work-team-contribution.get",
      "teacher.work-team-contribution.get",
    ]);
    const carriers = ROUTES.filter((route) =>
      route.responses.some((response) => {
        const text = JSON.stringify(response.body ?? null);
        return text.includes("not_authorship_evidence") && text.includes("totalCodePoints");
      }),
    ).map((route) => route.id);
    expect(carriers.sort()).toEqual([...own].sort());
  });

  it("shows a student only names and ids of the student's own team and the open teams as a count", () => {
    const text = JSON.stringify(
      ROUTES.find((r) => r.id === "student.work-team.get")!.responses[0]!.body,
    );
    expect(text).not.toContain("studentId");
    expect(text).not.toContain("workState");
    expect(text).toContain("memberCount");
  });
});

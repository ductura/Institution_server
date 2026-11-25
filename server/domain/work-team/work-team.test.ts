import { describe, expect, it } from "vitest";

import {
  assembleContribution,
  CONTRIBUTION_CATEGORIES,
  isValidTeamSetting,
  orderByName,
  type TeamMemberPart,
} from "./index.ts";

// Everything here is invented.
const ready = (
  id: string,
  givenName: string,
  familyName: string,
  codePoints: Partial<Record<(typeof CONTRIBUTION_CATEGORIES)[number], number>>,
): TeamMemberPart => ({ id, givenName, familyName, part: { state: "ready", codePoints } });

describe("order of the people of a team", () => {
  it("is family name, given name, id in Croatian collation", () => {
    const people = [
      { id: "3", givenName: "Ana", familyName: "Šimić" },
      { id: "2", givenName: "Ivo", familyName: "Čaić" },
      { id: "1", givenName: "Ana", familyName: "Čaić" },
      { id: "0", givenName: "Ana", familyName: "Zorić" },
      { id: "4", givenName: "Ana", familyName: "Čaić" },
    ];
    expect(orderByName(people).map((p) => p.id)).toEqual(["1", "4", "2", "3", "0"]);
    expect(people[0]?.id).toBe("3");
  });
});

describe("contribution", () => {
  const members = [
    ready("b", "Ivo", "Zorić", { written: 10 }),
    ready("a", "Ana", "Babić", { written: 9000, pasted: 5, unattributed: 1 }),
  ];

  it("lists members in alphabetical order whatever their amounts, in the fixed category order", () => {
    const answer = assembleContribution({ enabled: true, members });
    expect(answer).toMatchObject({ state: "ready", notice: "not_authorship_evidence" });
    if (answer.state !== "ready") throw new Error("not ready");
    expect(answer.members.map((m) => m.familyName)).toEqual(["Babić", "Zorić"]);
    // The same people with the amounts the other way round keep the same order.
    const swapped = assembleContribution({
      enabled: true,
      members: [
        ready("b", "Ivo", "Zorić", { written: 99999 }),
        ready("a", "Ana", "Babić", { written: 1 }),
      ],
    });
    if (swapped.state !== "ready") throw new Error("not ready");
    expect(swapped.members.map((m) => m.familyName)).toEqual(["Babić", "Zorić"]);
    expect(answer.members[0]?.categories.map((c) => c.category)).toEqual([
      ...CONTRIBUTION_CATEGORIES,
    ]);
    expect(answer.members[0]?.totalCodePoints).toBe(9006);
  });

  it("carries no share, rank, average, comparison or threshold", () => {
    const text = JSON.stringify(assembleContribution({ enabled: true, members }));
    for (const word of ["share", "percent", "rank", "average", "threshold", "color"]) {
      expect(text).not.toContain(word);
    }
  });

  it("reads disabled, none, failed and pending without a reason", () => {
    expect(assembleContribution({ enabled: false, members })).toEqual({ state: "disabled" });
    expect(assembleContribution({ enabled: true, members: null })).toEqual({ state: "none" });
    expect(assembleContribution({ enabled: true, members: [] })).toEqual({ state: "none" });
    const pending: TeamMemberPart = {
      id: "p",
      givenName: "Pero",
      familyName: "Perić",
      part: { state: "pending" },
    };
    const failed: TeamMemberPart = { ...pending, id: "f", part: { state: "failed" } };
    expect(assembleContribution({ enabled: true, members: [...members, pending] })).toEqual({
      state: "pending",
    });
    expect(assembleContribution({ enabled: true, members: [...members, pending, failed] })).toEqual(
      {
        state: "failed",
      },
    );
  });

  it("does not make up a number: an unusable count fails the answer", () => {
    expect(
      assembleContribution({ enabled: true, members: [ready("a", "A", "B", { written: -1 })] }),
    ).toEqual({ state: "failed" });
    expect(
      assembleContribution({ enabled: true, members: [ready("a", "A", "B", { written: 1.5 })] }),
    ).toEqual({ state: "failed" });
  });
});

describe("setting", () => {
  it("wants 2 to 6, the fewest not above the most, and a known formation", () => {
    expect(isValidTeamSetting({ minSize: 2, maxSize: 6, formation: "student_choice" })).toBe(true);
    expect(isValidTeamSetting({ minSize: 4, maxSize: 3, formation: "student_choice" })).toBe(false);
    expect(isValidTeamSetting({ minSize: 1, maxSize: 3, formation: "student_choice" })).toBe(false);
    expect(isValidTeamSetting({ minSize: 2, maxSize: 7, formation: "student_choice" })).toBe(false);
    expect(isValidTeamSetting({ minSize: 2, maxSize: 3, formation: "x" })).toBe(false);
  });
});

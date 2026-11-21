import { describe, expect, it } from "vitest";

import {
  AI_POLICIES,
  type AiPolicy,
  type PolicyInput,
  decidePolicy,
  effectiveAiPolicy,
} from "./policy.ts";

function input(over: {
  faculty?: AiPolicy;
  course?: AiPolicy;
  assignment?: AiPolicy;
  purposes?: readonly string[];
  version?: number;
  requestVersion?: number;
  key?: string;
  switchOn?: boolean;
}): PolicyInput {
  return {
    faculty: over.faculty === undefined ? undefined : { aiPolicy: over.faculty },
    course: { aiPolicy: over.course ?? "partially_allowed" },
    assignmentVersion: {
      aiPolicy: over.assignment ?? "partially_allowed",
      aiPurposes: over.purposes ?? ["proofreading", "translation"],
      purposeCatalogVersion: over.version ?? 1,
    },
    institution: { transcriptionAndToolsEnabled: over.switchOn ?? false },
    request: {
      purposeCatalogVersion: over.requestVersion ?? over.version ?? 1,
      purposeKey: over.key ?? "proofreading",
    },
  };
}

function rule(over: Parameters<typeof input>[0]): string {
  const decision = decidePolicy(input(over));
  return decision.ok ? "pass" : decision.rule;
}

describe("effective policy: the course decides, the faculty is only its default (D-175)", () => {
  it("faculty prohibited and the course explicitly allows: passes", () => {
    for (const course of ["partially_allowed", "encouraged"] as const)
      expect(rule({ faculty: "prohibited", course, assignment: "partially_allowed" })).toBe("pass");
  });

  it("faculty allows and the course is prohibited: refused", () => {
    for (const faculty of ["partially_allowed", "encouraged"] as const)
      expect(rule({ faculty, course: "prohibited", assignment: "partially_allowed" })).toBe(
        "policy_prohibited",
      );
  });

  it("the faculty value never changes the decision", () => {
    for (const course of AI_POLICIES)
      for (const assignment of AI_POLICIES) {
        const without = decidePolicy(input({ course, assignment }));
        for (const faculty of AI_POLICIES)
          expect(
            decidePolicy(input({ faculty, course, assignment })),
            `${faculty}/${course}/${assignment}`,
          ).toEqual(without);
      }
  });
});

describe("the assignment only narrows the course (D-52, P2, P3)", () => {
  it("effective policy is the narrower of course and assignment", () => {
    expect(effectiveAiPolicy("encouraged", "partially_allowed")).toBe("partially_allowed");
    expect(effectiveAiPolicy("partially_allowed", "encouraged")).toBe("partially_allowed");
    expect(effectiveAiPolicy("encouraged", "prohibited")).toBe("prohibited");
    expect(effectiveAiPolicy("encouraged", "allowed")).toBeNull();
    expect(effectiveAiPolicy("constructor", "encouraged")).toBeNull();
  });

  it("assignment prohibited refuses every purpose, even one listed", () => {
    expect(rule({ course: "encouraged", assignment: "prohibited" })).toBe("policy_prohibited");
  });

  it("an unknown policy value fails closed", () => {
    const bad = { ...input({}), course: { aiPolicy: "allowed" as AiPolicy } };
    expect(decidePolicy(bad)).toEqual({
      ok: false,
      outcome: "purpose_not_allowed",
      rule: "policy_invalid",
    });
  });

  it("a purpose outside the version's ai_purposes is refused, also after a narrower version", () => {
    expect(rule({ key: "formatting" })).toBe("purpose_not_in_assignment");
    expect(rule({ key: "translation", purposes: ["translation"] })).toBe("pass");
    expect(rule({ key: "translation", purposes: ["proofreading"] })).toBe(
      "purpose_not_in_assignment",
    );
  });
});

describe("catalogue version and level 2 (P4, P5, D-64, D-268 O2)", () => {
  it("the request's catalogue version must be the assignment's", () => {
    expect(rule({ version: 1, requestVersion: 2 })).toBe("catalog_version_mismatch");
    expect(rule({ version: 2, requestVersion: 1 })).toBe("catalog_version_mismatch");
  });

  it("a key of version 2 does not exist on a version 1 assignment", () => {
    expect(
      rule({ version: 1, key: "explanation", purposes: ["proofreading", "explanation"] }),
    ).toBe("purpose_unknown");
    expect(rule({ version: 3, key: "proofreading" })).toBe("purpose_unknown");
    expect(rule({ key: "drafting" })).toBe("purpose_unknown");
  });

  it("level 2 passes only when the teacher listed it on this assignment", () => {
    expect(rule({ version: 2, key: "explanation", purposes: ["proofreading"] })).toBe(
      "level_2_not_enabled",
    );
    expect(
      rule({ version: 2, key: "explanation", purposes: ["proofreading", "explanation"] }),
    ).toBe("pass");
    // Same course, another assignment that did not list it.
    expect(rule({ version: 2, key: "explanation", purposes: ["brainstorming"] })).toBe(
      "level_2_not_enabled",
    );
  });

  it("returns the purpose entry it matched", () => {
    const decision = decidePolicy(
      input({ version: 2, key: "data_coding", purposes: ["data_coding"] }),
    );
    expect(decision).toEqual({
      ok: true,
      effectivePolicy: "partially_allowed",
      purpose: { key: "data_coding", level: 2, enabledByDefault: false },
    });
  });
});

describe("institution switch for transcription (P9)", () => {
  it("is off by default and refuses transcription even when the assignment allows it", () => {
    expect(rule({ key: "transcription", purposes: ["transcription"] })).toBe(
      "institution_switch_off",
    );
    expect(rule({ key: "transcription", purposes: ["transcription"], switchOn: true })).toBe(
      "pass",
    );
  });

  it("does not touch other purposes", () => {
    expect(rule({ key: "proofreading", switchOn: false })).toBe("pass");
  });
});

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { defaultRubricCriteria } from "./index.ts";

// SRV-V17-RUBRIC-DEF: the default criteria a student reads while the teacher set none are the six
// working criteria (SRV-1107), in the same order, as message keys that the catalogue has.
describe("default rubric criteria", () => {
  const catalogue = JSON.parse(
    readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8"),
  ) as Record<string, Record<string, string>>;
  const textOf = (key: string) => catalogue[key.split(".")[0]!]?.[key.split(".")[1]!];

  it("are the six working criteria, each title a key with a text", () => {
    const criteria = defaultRubricCriteria();
    expect(criteria.map((c) => c.id)).toEqual([
      "topic",
      "structure",
      "sources",
      "method",
      "language",
      "formatting",
    ]);
    for (const c of criteria) expect(textOf(c.title)).toBeTruthy();
  });

  it("have three levels as keys with a text, and no number", () => {
    for (const criterion of defaultRubricCriteria()) {
      expect(criterion.levels).toHaveLength(3);
      for (const level of criterion.levels) expect(textOf(level.label)).toBeTruthy();
      expect(Object.keys(criterion).sort()).toEqual(["id", "levels", "title"]);
    }
  });

  it("returns a fresh list each time", () => {
    defaultRubricCriteria()[0]!.title = "promijenjeno";
    expect(defaultRubricCriteria()[0]!.title).toBe("workingCriteria.topic");
  });
});

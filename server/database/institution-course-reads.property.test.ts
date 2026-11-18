// DAN-1089: port of the permutation property of Ductus
// src/server/institution/institution-courses.test.ts at 70c168f. Whatever
// order the function's rows come in, the courses are the same, every course
// and every team or group teacher row is in them once. Invented people only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { institutionCoursesOf } from "./institution-course-reads.ts";

type Row = Record<string, unknown>;
type Pair = [string, string] | null;
const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const EMPTY: Row = {
  ...{ kind: null, course_id: null, course_name: null, group_id: null, group_name: null },
  ...{ user_id: null, given_name: null, family_name: null, students: null },
};
const person = (kind: string, c: number, u: number, name: Pair, g?: number): Row => ({
  ...EMPTY,
  ...{ kind, course_id: id(c), user_id: id(u), group_id: g === undefined ? null : id(g) },
  ...{ given_name: name?.[0] ?? null, family_name: name?.[1] ?? null },
});

describe("institutionCoursesOf", () => {
  it("gives the same courses, as a permutation of the rows, whatever order the rows come in", () => {
    const pairs: [string, string][] = [
      ["Ana", "Cvjetić"],
      ["Bor", "Čavlić"],
      ["Ivo", "Zorić"],
    ];
    const names = fc.option(fc.constantFrom(...pairs), { nil: null });
    const shape = fc.uniqueArray(
      fc.record({
        c: fc.integer({ min: 1, max: 50 }),
        title: fc.constantFrom("Čitanje", "Cvijeće", "Zakon"),
        team: fc.uniqueArray(fc.integer({ min: 100, max: 120 }), { maxLength: 4 }),
        groups: fc.uniqueArray(fc.integer({ min: 0, max: 5 }), { maxLength: 3 }),
        holder: fc.boolean(),
      }),
      { selector: (r) => r.c, maxLength: 6 },
    );
    fc.assert(
      fc.property(shape, fc.func(names), fc.func(fc.integer()), (list, nameOf, key) => {
        const input = list.flatMap(({ c, title, team, groups, holder }) => [
          {
            ...EMPTY,
            kind: "course",
            course_id: id(c),
            course_name: title,
            students: groups.length,
          },
          ...(holder && team[0] !== undefined
            ? [person("holder", c, team[0], nameOf(team[0]))]
            : []),
          ...team.map((u) => person("team", c, u, nameOf(u))),
          ...groups.flatMap((g) => {
            const gid = 1000 + c * 10 + g;
            return [
              {
                ...EMPTY,
                kind: "group",
                course_id: id(c),
                group_id: id(gid),
                group_name: `Grupa ${g}`,
                students: 1,
              },
              ...team.slice(0, g % 3).map((u) => person("group_teacher", c, u, nameOf(u), gid)),
            ];
          }),
        ]);
        const shuffled = input
          .map((r, i) => ({ r, k: key(i) }))
          .sort((a, b) => a.k - b.k)
          .map((x) => x.r);
        const first = institutionCoursesOf(input);
        expect(first).not.toBeNull();
        expect(institutionCoursesOf(shuffled)).toEqual(first);
        expect(first!.map((c) => c.courseId).sort()).toEqual(list.map((l) => id(l.c)).sort());
        const people = first!.flatMap((c) => [...c.team, ...c.groups.flatMap((g) => g.teachers)]);
        expect(people.length).toBe(
          input.filter((r) => r.kind === "team" || r.kind === "group_teacher").length,
        );
      }),
    );
  });
});

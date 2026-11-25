// SRV-V19-GRUPA-RUTE (Ductus#2055; val 19): the order of the people of a team.
// The order is a fact of the names and never of an amount: family name, then
// given name (Croatian collation), then the id, so two people with the same
// name keep one stable order. There is no parameter that sorts by anything else.
const collate = (a: string, b: string): number => a.localeCompare(b, "hr");

export type NamedPerson = { readonly givenName: string; readonly familyName: string };

/** The one order of the members of a team and of the students without a team. */
export function compareByName(
  a: NamedPerson & { readonly id?: string },
  b: NamedPerson & { readonly id?: string },
): number {
  return (
    collate(a.familyName, b.familyName) ||
    collate(a.givenName, b.givenName) ||
    (a.id ?? "").localeCompare(b.id ?? "")
  );
}

/** The people in the one order of their names; the input is not changed. */
export function orderByName<T extends NamedPerson & { readonly id?: string }>(
  people: readonly T[],
): T[] {
  return [...people].sort(compareByName);
}

/** What the teacher may set: 2 to 6 members, the fewest not above the most. */
export function isValidTeamSetting(input: {
  minSize: number;
  maxSize: number;
  formation: string;
}): boolean {
  const size = (value: number) => Number.isInteger(value) && value >= 2 && value <= 6;
  return (
    size(input.minSize) &&
    size(input.maxSize) &&
    input.minSize <= input.maxSize &&
    (input.formation === "student_choice" || input.formation === "teacher_assigned")
  );
}

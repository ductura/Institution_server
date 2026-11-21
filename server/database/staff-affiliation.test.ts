import { describe, expect, it, vi } from "vitest";

import {
  createMyStaffAffiliationReader,
  myStaffAffiliationOf,
  STAFF_AFFILIATION_MISSING_CODE,
} from "./staff-affiliation.ts";
import type { WithActor } from "./with-actor.ts";

// SRV-1403: the reader over identity.my_staff_affiliation(); synthetic rows only.
const AT = new Date("2026-11-20T08:30:00.000Z");

function withRows(rows: unknown[] | Error): WithActor {
  return vi.fn(async (_token, fn) =>
    fn({
      query: async () => {
        if (rows instanceof Error) throw rows;
        return { rows: rows as never[], rowCount: rows.length };
      },
    }),
  ) as unknown as WithActor;
}

describe("myStaffAffiliationOf", () => {
  it("acceptance 2: no row is the closed code, and the person stays a student", () => {
    expect(myStaffAffiliationOf([])).toStrictEqual({
      confirmed: false,
      code: "staff_affiliation_missing",
    });
    expect(STAFF_AFFILIATION_MISSING_CODE).toBe("staff_affiliation_missing");
  });

  it("one row is the source and the time of the last confirmation", () => {
    expect(
      myStaffAffiliationOf([{ source: "eduPersonScopedAffiliation", confirmedAt: AT }]),
    ).toStrictEqual({
      confirmed: true,
      source: "eduPersonScopedAffiliation",
      confirmedAt: "2026-11-20T08:30:00.000Z",
    });
  });

  it.each([
    [
      "two rows",
      [
        { source: "eduPersonAffiliation", confirmedAt: AT },
        { source: "eduPersonAffiliation", confirmedAt: AT },
      ],
    ],
    ["an unknown source", [{ source: "student", confirmedAt: AT }]],
    ["a null source", [{ source: null, confirmedAt: AT }]],
    ["a text time", [{ source: "eduPersonAffiliation", confirmedAt: "2026-11-20" }]],
    ["an invalid time", [{ source: "eduPersonAffiliation", confirmedAt: new Date(Number.NaN) }]],
  ])("throws on %s", (ignoredLabel, rows) => {
    expect(() => myStaffAffiliationOf(rows)).toThrow("myStaffAffiliation: malformed row");
  });
});

describe("createMyStaffAffiliationReader", () => {
  it("reads one statement in withActor with the token", async () => {
    const withActor = withRows([{ source: "hrEduPersonAffiliation", confirmedAt: AT }]);
    const token = "a".repeat(43);
    await expect(createMyStaffAffiliationReader(withActor)(token)).resolves.toStrictEqual({
      ok: true,
      value: { confirmed: true, source: "hrEduPersonAffiliation", confirmedAt: AT.toISOString() },
    });
    expect(vi.mocked(withActor).mock.calls[0]![0]).toBe(token);
  });

  it("ZD401 is unauthenticated, anything else is thrown on", async () => {
    const zd401 = Object.assign(new Error("not authenticated"), { code: "ZD401" });
    await expect(createMyStaffAffiliationReader(withRows(zd401))("t")).resolves.toStrictEqual({
      ok: false,
      reason: "unauthenticated",
    });
    const other = Object.assign(new Error("down"), { code: "08006" });
    await expect(createMyStaffAffiliationReader(withRows(other))("t")).rejects.toBe(other);
  });
});

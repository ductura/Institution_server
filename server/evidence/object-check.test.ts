// DAN-820 820c-4a, plan of attack ductura/server#146 P-6: the answer of the
// segment object check lets the signing go on only as `present`. C1 and C2
// are ported from Ductus sign-pending-receipt.test.ts at 333e163 with the same
// outcomes, asked here of `objectOutcome` itself (that nothing is signed or
// stored then is asserted through the factory in 820c-4b and 4c). The rows
// marked new are not in the source.
import { describe, expect, it } from "vitest";

import { objectOutcome } from "./object-check.ts";

describe("objectOutcome stops the signing for every answer but present (P-6)", () => {
  const holds = ["not_pending", "locator_mismatch", "object_absent", "object_mismatch"] as const;
  it.each(holds)("C1 an object check held as %s is held", (reason) => {
    expect(objectOutcome({ status: "held", reason })).toEqual({ status: "held", reason });
  });

  const inherited: unknown = Object.create({ status: "present" });
  const objectFaults: [string, unknown, string][] = [
    [
      "locator unavailable",
      { status: "unavailable", reason: "locator_unavailable" },
      "locator_unavailable",
    ],
    [
      "locator malformed",
      { status: "unavailable", reason: "locator_malformed" },
      "locator_malformed",
    ],
    [
      "storage ref unavailable",
      { status: "unavailable", reason: "storage_ref_unavailable" },
      "storage_ref_unavailable",
    ],
    [
      "presence unavailable",
      { status: "unavailable", reason: "presence_unavailable" },
      "presence_unavailable",
    ],
    [
      "an unknown unavailable reason",
      { status: "unavailable", reason: "x" },
      "presence_unavailable",
    ],
    ["a held reason outside the set", { status: "held", reason: "other" }, "presence_unavailable"],
    ["answers null", null, "presence_unavailable"],
    ["answers a string", "present", "presence_unavailable"],
    ["answers an unknown status", { status: "maybe" }, "presence_unavailable"],
    // New: the classes of an outside answer.
    ["answers undefined", undefined, "presence_unavailable"],
    ["answers present in capitals", { status: "PRESENT" }, "presence_unavailable"],
    ["answers present as an inherited key", inherited, "presence_unavailable"],
    ["answers an array", [{ status: "present" }], "presence_unavailable"],
    [
      "answers held with toString as the reason",
      { status: "held", reason: "toString" },
      "presence_unavailable",
    ],
    [
      "answers unavailable with __proto__ as the reason",
      { status: "unavailable", reason: "__proto__" },
      "presence_unavailable",
    ],
  ];
  it.each(objectFaults)("C2 an object check that %s is unavailable", (_, check, reason) => {
    expect(objectOutcome(check)).toEqual({ status: "unavailable", stage: "object", reason });
  });
});

describe("controls", () => {
  it("present lets the signing go on", () => {
    expect(objectOutcome({ status: "present" })).toBeNull();
  });
  it("present with no prototype lets it go on as well", () => {
    expect(
      objectOutcome(Object.assign(Object.create(null) as object, { status: "present" })),
    ).toBeNull();
  });
});

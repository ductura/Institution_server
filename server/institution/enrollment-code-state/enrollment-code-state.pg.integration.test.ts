import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";

import { readEnrollmentCodeState } from "./index.ts";

// db/main/tests/fixtures/institution.inc: K1 has an active code and a
// revoked one, K2 only an expired active one, K3 is another institution's.
// Tokens are one letter per person in id order: Vesna A (teacher of K1),
// Marko B (teacher of K2), Iva C (administrator), Ana D (student in K1),
// Petra I (teacher of K3 at the other institution).
const FIXTURE = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const K1 = "00000000-0000-4000-8000-0000000000c1";
const K2 = "00000000-0000-4000-8000-0000000000c2";
const K3 = "00000000-0000-4000-8000-0000000000c3";
const MISSING = "00000000-0000-4000-8000-00000000dead";
const [VESNA, MARKO, IVA, ANA, PETRA] = ["A", "B", "C", "D", "I"].map((c) => c.repeat(43)) as [
  string,
  string,
  string,
  string,
  string,
];

it("reads the active code's deadline only as a teacher of the course under PostgreSQL RLS", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(FIXTURE);
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const active = await db.query<{ validUntil: Date }>(
      'SELECT valid_until AS "validUntil" FROM institution.course_enrollment_code WHERE course_id = $1 AND active',
      [K1],
    );
    expect(await readEnrollmentCodeState(withActor, VESNA, K1)).toEqual({
      kind: "found",
      body: { current: { validUntil: active.rows[0]!.validUntil.toISOString() } },
    });
    // An expired code is still current: the client shows it as expired.
    const expired = await readEnrollmentCodeState(withActor, MARKO, K2);
    if (expired.kind !== "found" || expired.body.current === null) {
      throw new Error("K2 has an expired active code");
    }
    expect(Date.parse(expired.body.current.validUntil)).toBeLessThan(Date.now());

    for (const [token, id] of [
      [VESNA, K2],
      [VESNA, K3],
      [VESNA, MISSING],
      [MARKO, K1],
      [IVA, K1],
      [ANA, K1],
      [PETRA, K1],
    ] as const) {
      expect(await readEnrollmentCodeState(withActor, token, id)).toEqual({ kind: "not_found" });
    }
    expect(await readEnrollmentCodeState(withActor, "Z".repeat(43), K1)).toEqual({
      kind: "unauthorized",
    });

    // After the revocation the course has no current code.
    await withActor(VESNA, (tx) => tx.query("SELECT institution.revoke_enrollment_code($1)", [K1]));
    expect(await readEnrollmentCodeState(withActor, VESNA, K1)).toEqual({
      kind: "found",
      body: { current: null },
    });
  } finally {
    await db.close();
  }
});

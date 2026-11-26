// SRV-F4-PM2-R15 over a real database (20261220210000): the port of the plan of
// a work as the routes call it. The rules themselves are
// db/main/tests/261-work-plan.sql; this checks the mapping of real rows.
// Invented personas of the fixtures.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createWorkPlanStore, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const WORK = "doc-a";
const STUDENT = "D".repeat(43);
const TEACHER = "A".repeat(43);
const OTHER_STUDENT = "E".repeat(43);
const NODE = "1f0e2d3c-4b5a-4968-8776-655443322110";
const PLAN = {
  question: "Izmišljeno pitanje rada?",
  purposes: [{ nodeId: NODE, purpose: "Izmišljena svrha." }],
  terms: [{ term: "Pojam", definition: "Izmišljena definicija.", kind: "term" as const }],
};

it("keeps the plan of a work for its owner alone, whole, and drops an empty one", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(
      readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
        /^\\ir institution\.inc\r?\n/mu,
        "",
      ),
    );
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(sql: string, args?: readonly unknown[]) {
            const { rows } = await db.query<Row>(sql, [...(args ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const plans = createWorkPlanStore(withActor);

    const none = { question: null, purposes: [], terms: [], updatedAt: null };
    expect(await plans.read(STUDENT, WORK)).toEqual({ status: "ok", plan: none });

    const written = await plans.write(STUDENT, WORK, PLAN);
    expect(written).toMatchObject({ status: "ok", plan: PLAN });
    if (written.status !== "ok") throw new Error("not written");
    expect(written.plan.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/u);
    expect(await plans.read(STUDENT, WORK)).toEqual(written);

    // The teacher of the work, another student and no session read and write nothing.
    for (const other of [TEACHER, OTHER_STUDENT]) {
      expect(await plans.read(other, WORK)).toEqual({ status: "not_found" });
      expect(await plans.write(other, WORK, { ...PLAN, question: "Tuđe." })).toEqual({
        status: "not_found",
      });
    }
    expect(await plans.read("Z".repeat(43), WORK)).toEqual({ status: "unauthenticated" });
    expect(await plans.read(STUDENT, "doc-nema")).toEqual({ status: "not_found" });
    expect(await plans.read(STUDENT, WORK)).toEqual(written);

    // A block twice, and a term twice (case aside), are refused and change nothing.
    expect(
      await plans.write(STUDENT, WORK, {
        ...PLAN,
        purposes: [...PLAN.purposes, { nodeId: NODE.toUpperCase(), purpose: "Druga." }],
      }),
    ).toEqual({ status: "invalid" });
    expect(
      await plans.write(STUDENT, WORK, {
        ...PLAN,
        terms: [...PLAN.terms, { term: "POJAM", definition: "Druga.", kind: "term" }],
      }),
    ).toEqual({ status: "invalid" });
    expect(await plans.read(STUDENT, WORK)).toEqual(written);

    // An empty plan is not kept.
    expect(await plans.write(STUDENT, WORK, { question: null, purposes: [], terms: [] })).toEqual({
      status: "ok",
      plan: none,
    });
    const rows = await db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM collaboration.work_plan",
    );
    expect(rows.rows[0]!.n).toBe("0");
  } finally {
    await db.close();
  }
});

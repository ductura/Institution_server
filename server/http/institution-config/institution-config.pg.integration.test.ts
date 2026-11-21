// SRV-1406 acceptance on the real database, through the port the routes use:
// (2) a teacher and a student are refused, reading and publishing; (3) rules
// the schema refuses never reach the database; (4) every new version leaves
// one row in audit.institution_config_event, written with the version.
// Every person, institution and rule is that of the shared pgTAP fixture.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createInstitutionConfigStore, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const VESNA = "A".repeat(43); // teacher of fak-a
const IVA = "C".repeat(43); // administrator of fak-a
const ANA = "D".repeat(43); // student of fak-a
const LEA = "H".repeat(43); // administrator of fak-b
const RULES = { citationStyle: "fpzg", workLanguages: ["hr", "en"], defaultWorkLanguage: "hr" };
const RULES_2 = { citationStyle: "fpzg", workLanguages: ["hr"], defaultWorkLanguage: "hr" };

it("lets only the administrator read and add versions, and records each in the audit trail", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
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
    const store = createInstitutionConfigStore(withActor);
    const trail = async () =>
      (
        await db.query<{ version: number; kind: string }>(
          "SELECT version, kind FROM audit.institution_config_event ORDER BY institution_id, version",
        )
      ).rows;

    // (2) a teacher and a student: 403 for reading and for publishing; no session: 401.
    for (const token of [VESNA, ANA]) {
      expect(await store.versions(token)).toEqual({ status: "forbidden" });
      expect(await store.publish(token, 0, RULES)).toEqual({ status: "forbidden" });
    }
    expect(await store.versions("Z".repeat(43))).toEqual({ status: "unauthorized" });
    expect(await trail()).toEqual([]);

    // (3) rules the schema refuses never reach the database.
    expect(
      await store.publish(IVA, 0, { ...RULES, defaultWorkLanguage: "en", workLanguages: ["hr"] }),
    ).toEqual({
      status: "invalid_input",
    });
    expect(await store.publish(IVA, 0, { ...RULES, aiPolicy: "encouraged" })).toEqual({
      status: "invalid_input",
    });
    expect(await trail()).toEqual([]);

    // (4) each published version has its audit row, the stale one none.
    expect(await store.publish(IVA, 0, RULES)).toEqual({ status: "ok", version: 1 });
    expect(await store.publish(IVA, 0, RULES_2)).toEqual({ status: "conflict" });
    expect(await store.publish(IVA, 1, RULES_2)).toEqual({ status: "ok", version: 2 });
    expect(await store.publish(LEA, 0, RULES)).toEqual({ status: "ok", version: 1 });
    expect(await trail()).toHaveLength(3);
    const actors = await db.query<{ ok: boolean }>(
      `SELECT e.actor_id = c.created_by AND e.occurred_at = c.created_at AS ok
         FROM audit.institution_config_event e JOIN app.institution_config c USING (institution_id, version)`,
    );
    expect(actors.rows.every((r) => r.ok)).toBe(true);

    // The administrator reads the own history only.
    const own = await store.versions(IVA);
    expect(own.status === "ok" ? own.versions.map((v) => v.version) : null).toEqual([1, 2]);
    const other = await store.versions(LEA);
    expect(other.status === "ok" ? other.versions.map((v) => v.version) : null).toEqual([1]);
  } finally {
    await db.close();
  }
});

import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createConsultationRecords, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const DOCUMENT = "doc-a";
const STUDENT = "D".repeat(43);
const TEACHER = "A".repeat(43);
const OTHER_STUDENT = "E".repeat(43);
const OTHER_TENANT = "I".repeat(43);

it("stores one shared record under ductus_app that the student and the teacher both read", async () => {
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
    const port = createConsultationRecords(withActor);
    // The fixture work has only its empty revision 0; a consultation is about a version.
    await db.query(
      `INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
       SELECT document_id, institution_id, 1, 0, principal_id, content_hash
         FROM evidence.document_revision WHERE document_id = $1 AND revision = 0`,
      [DOCUMENT],
    );
    const input = {
      heldOn: "2026-11-18",
      revision: 1,
      topic: "Izmišljena struktura rada",
      agreement: "Dodati zaključak do petka.",
    };

    // The revision must exist in this work; an empty topic is refused.
    expect(await port.create(TEACHER, DOCUMENT, { ...input, revision: 9999 })).toEqual({
      status: "invalid_input",
    });
    expect(await port.create(TEACHER, DOCUMENT, { ...input, topic: "  " })).toEqual({
      status: "invalid_input",
    });
    const created = await port.create(TEACHER, DOCUMENT, input);
    expect(created.status).toBe("ok");
    if (created.status !== "ok") return;

    expect(await port.addAddition(TEACHER, DOCUMENT, created.record.id, "")).toEqual({
      status: "invalid_input",
    });
    const added = await port.addAddition(TEACHER, DOCUMENT, created.record.id, "Rok je pomaknut.");
    expect(added.status).toBe("ok");
    if (added.status !== "ok") return;

    // The student reads, after loading, the same addition as the teacher.
    const [asStudent, asTeacher] = await Promise.all([
      port.list(STUDENT, DOCUMENT),
      port.list(TEACHER, DOCUMENT),
    ]);
    expect(asStudent).toEqual(asTeacher);
    expect(asStudent).toMatchObject({
      status: "ok",
      records: [{ id: created.record.id, ...input, additions: [added.addition] }],
    });
    const studentAdded = await port.addAddition(STUDENT, DOCUMENT, created.record.id, "Razumijem.");
    expect(studentAdded.status).toBe("ok");
    const again = await port.list(TEACHER, DOCUMENT);
    expect(again.status === "ok" && again.records[0]?.additions.map((a) => a.text)).toEqual([
      "Rok je pomaknut.",
      "Razumijem.",
    ]);

    // Another student, another institution and an unknown work read a missing one.
    for (const token of [OTHER_STUDENT, OTHER_TENANT]) {
      expect(await port.list(token, DOCUMENT)).toEqual({ status: "not_found" });
      expect(await port.create(token, DOCUMENT, input)).toEqual({ status: "not_found" });
      expect(await port.addAddition(token, DOCUMENT, created.record.id, "Tekst.")).toEqual({
        status: "not_found",
      });
    }
    expect(await port.list(STUDENT, "doc-nema")).toEqual({ status: "not_found" });
    expect(await port.list("x".repeat(43), DOCUMENT)).toEqual({ status: "unauthenticated" });
  } finally {
    await db.close();
  }
});

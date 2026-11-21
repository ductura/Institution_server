// SRV-1702 acceptance on the real RPCs in PostgreSQL, through the ports the
// routes use (createLiveStates for the student's publish, createDirectEdits for
// the setting and the teacher's edit): (1) without the setting on, a teacher's
// edit fails; (2) revocation acts at once; (3) the edit is marked as the
// teacher's in the record; (4) the setting is visible on the work, the same for
// the student and the teacher. Every person, document and text is invented; the
// documents are those of the shared pgTAP fixture.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createDirectEdits, createLiveStates, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const WORK = "doc-a";
const TEACHER = "A".repeat(43); // Vesna, teacher of K1
const STUDENT = "D".repeat(43); // Ana, owner of doc-a
const OTHER_STUDENT = "E".repeat(43); // Dora, in K1 too
const OTHER_TENANT = "I".repeat(43); // Petra, teacher in fak-b
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const S1 = '{"nodes":[{"text":"Izmišljeni tekst rada."}],"schemaVersion":1}';
const S2 =
  '{"nodes":[{"text":"Izmišljeni tekst rada, s ispravkom nastavnika."}],"schemaVersion":1}';
const S3 = '{"nodes":[{"text":"Izmišljeni tekst rada, s drugim ispravkom."}],"schemaVersion":1}';

it("lets a teacher edit only while the student has direct edits on, and records the edit as the teacher's", async () => {
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
    const live = createLiveStates(withActor);
    const edits = createDirectEdits(withActor);

    expect(await live.publish(STUDENT, WORK, null, S1)).toMatchObject({ status: "accepted" });

    // (4) suggestions by default, the same answer for both sides.
    const before = await edits.read(STUDENT, WORK);
    expect(before).toEqual({ status: "ok", mode: "suggestions", changedAt: null, record: [] });
    expect(await edits.read(TEACHER, WORK)).toEqual(before);

    // (1) without the setting on, the teacher's edit fails and the state stays.
    expect(await edits.publishTeacherEdit(TEACHER, WORK, sha(S1), S2)).toEqual({
      status: "not_found",
    });
    expect(await edits.set(TEACHER, WORK, "direct")).toEqual({ status: "not_found" });

    expect(await edits.set(STUDENT, WORK, "direct")).toMatchObject({
      status: "ok",
      outcome: "applied",
      mode: "direct",
    });
    expect(await edits.read(TEACHER, WORK)).toMatchObject({ mode: "direct" });
    expect(await edits.read(TEACHER, WORK)).toEqual(await edits.read(STUDENT, WORK));

    const accepted = await edits.publishTeacherEdit(TEACHER, WORK, sha(S1), S2);
    expect(accepted).toMatchObject({ status: "accepted" });
    // The student's client reads the teacher's edit on the live channel.
    expect(await live.read(STUDENT, WORK, null)).toMatchObject({ status: "state", hash: sha(S2) });

    // (3) the record marks the edit as the teacher's, the same for both sides.
    const record = await edits.read(STUDENT, WORK);
    expect(record).toMatchObject({
      record: [
        { kind: "mode", source: "student", mode: "direct" },
        { kind: "teacher_edit", source: "teacher", bytes: Buffer.byteLength(S2) },
      ],
    });
    expect(await edits.read(TEACHER, WORK)).toEqual(record);

    // (2) revocation acts at once.
    expect(await edits.set(STUDENT, WORK, "suggestions")).toMatchObject({ outcome: "applied" });
    expect(await edits.publishTeacherEdit(TEACHER, WORK, sha(S2), S3)).toEqual({
      status: "not_found",
    });
    expect(await live.read(STUDENT, WORK, null)).toMatchObject({ hash: sha(S2) });

    // Nobody else reads or writes.
    expect(await edits.read(OTHER_STUDENT, WORK)).toEqual({ status: "not_found" });
    expect(await edits.read(OTHER_TENANT, WORK)).toEqual({ status: "not_found" });
    expect(await edits.set(OTHER_STUDENT, WORK, "direct")).toEqual({ status: "not_found" });
    expect(await edits.read("Z".repeat(43), WORK)).toEqual({ status: "unauthenticated" });
  } finally {
    await db.close();
  }
});

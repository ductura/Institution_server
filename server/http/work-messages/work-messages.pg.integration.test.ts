import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createWorkMessages, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const WORK = "doc-a";
const STUDENT = "D".repeat(43);
const TEACHER = "A".repeat(43);
const OTHER_STUDENT = "E".repeat(43);
const OTHER_TENANT = "I".repeat(43);

it("keeps one conversation for the student and the teacher, in a stable order, and refuses a blank message without a row", async () => {
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
    const messages = createWorkMessages(withActor);
    const count = async () =>
      (await db.query<{ n: string }>("SELECT count(*)::text AS n FROM collaboration.work_message"))
        .rows[0]!.n;

    const first = await messages.create(STUDENT, WORK, "Izmišljeno pitanje studenta.");
    expect(first).toMatchObject({
      status: "created",
      message: { senderRole: "student", text: "Izmišljeno pitanje studenta." },
    });
    expect(await messages.create(TEACHER, WORK, "Izmišljen odgovor nastavnika.")).toMatchObject({
      status: "created",
      message: { senderRole: "teacher" },
    });

    const seenByStudent = await messages.list(STUDENT, WORK);
    const seenByTeacher = await messages.list(TEACHER, WORK);
    expect(seenByStudent).toEqual(seenByTeacher);
    expect(seenByStudent).toMatchObject({ status: "ok" });
    const texts = (r: typeof seenByStudent) =>
      "messages" in r ? r.messages.map((m) => m.text) : [];
    expect(texts(seenByStudent)).toEqual([
      "Izmišljeno pitanje studenta.",
      "Izmišljen odgovor nastavnika.",
    ]);
    // Reading again gives the same order.
    expect(await messages.list(STUDENT, WORK)).toEqual(seenByStudent);

    const written = await count();
    for (const blank of ["", "   ", "\n\t"]) {
      expect(await messages.create(STUDENT, WORK, blank)).toEqual({ status: "invalid" });
    }
    expect(await count()).toBe(written);

    expect(await messages.list(OTHER_STUDENT, WORK)).toEqual({ status: "not_found" });
    expect(await messages.create(OTHER_TENANT, WORK, "Tekst.")).toEqual({ status: "not_found" });
    expect(await messages.list("Z".repeat(43), WORK)).toEqual({ status: "unauthenticated" });
  } finally {
    await db.close();
  }
});

// SRV-MENTOR-3 over a real database (20261214160000): the port of the note to
// self, the reading place and the seen marks, as the routes call it. The
// rules themselves are db/main/tests/233-mentorship-self-note-overview.sql;
// this checks the mapping of real rows. Invented personas of the fixtures.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import {
  createMentorshipFollow,
  createWorkMessages,
  type WithActor,
} from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const WORK = "doc-a";
const STUDENT = "D".repeat(43);
const TEACHER = "A".repeat(43);
const OTHER_STUDENT = "E".repeat(43);
const NODE = "1f0e2d3c-4b5a-4968-8776-655443322110";

it("keeps the note to self for its owner alone and records what the student has seen", async () => {
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
    const follow = createMentorshipFollow(withActor);
    const messages = createWorkMessages(withActor);

    expect(await follow.readSelfNote(STUDENT, WORK)).toEqual({
      status: "ok",
      state: { note: null, readingPlace: null },
    });
    const written = await follow.writeSelfNote(STUDENT, WORK, "Izmišljena bilješka.", {
      nodeId: NODE,
      offset: 3,
    });
    expect(written).toMatchObject({
      status: "ok",
      state: { note: { text: "Izmišljena bilješka.", place: { nodeId: NODE, offset: 3 } } },
    });
    const placed = await follow.writeReadingPlace(STUDENT, WORK, { nodeId: NODE, offset: 9 });
    expect(placed).toMatchObject({
      state: { note: { text: "Izmišljena bilješka." }, readingPlace: { place: { offset: 9 } } },
    });
    expect(await follow.readSelfNote(STUDENT, WORK)).toEqual(placed);
    expect(await follow.writeSelfNote(STUDENT, WORK, "a".repeat(281), null)).toEqual({
      status: "invalid",
    });

    // The teacher of the work, another student and no session read nothing.
    expect(await follow.readSelfNote(TEACHER, WORK)).toEqual({ status: "not_found" });
    expect(await follow.writeSelfNote(TEACHER, WORK, "Tuđe.", null)).toEqual({
      status: "not_found",
    });
    expect(await follow.readSelfNote(OTHER_STUDENT, WORK)).toEqual({ status: "not_found" });
    expect(await follow.readSelfNote("Z".repeat(43), WORK)).toEqual({ status: "unauthenticated" });

    expect(await follow.clear(STUDENT, WORK, "note")).toMatchObject({
      state: { note: null, readingPlace: { place: { offset: 9 } } },
    });
    expect(await follow.clear(STUDENT, WORK, "reading")).toEqual({
      status: "ok",
      state: { note: null, readingPlace: null },
    });

    // Seen marks: the teacher's message, opened by the student, is seen by its author.
    const sent = await messages.create(TEACHER, WORK, "Izmišljen odgovor nastavnika.");
    if (sent.status !== "created") throw new Error("the message was not written");
    expect(await follow.seenByStudent(TEACHER, WORK)).toEqual({ status: "ok", items: [] });
    const marked = await follow.markSeen(STUDENT, WORK, [{ kind: "message", id: sent.message.id }]);
    expect(marked).toMatchObject({
      status: "ok",
      items: [{ kind: "message", id: sent.message.id }],
    });
    expect(
      await follow.markSeen(STUDENT, WORK, [{ kind: "message", id: sent.message.id }]),
    ).toEqual(marked);
    expect(await follow.seenByStudent(TEACHER, WORK)).toEqual(marked);
    expect(await follow.seenByStudent(STUDENT, WORK)).toEqual({ status: "ok", items: [] });
    expect(
      await follow.markSeen(OTHER_STUDENT, WORK, [{ kind: "message", id: sent.message.id }]),
    ).toEqual({ status: "not_found" });
    expect(await follow.markSeen(STUDENT, WORK, [])).toEqual({ status: "invalid" });

    // The overview answers for a teacher; the fixtures hold no mentorship of this one.
    expect(await follow.overview(TEACHER)).toMatchObject({ status: "ok" });
    expect(await follow.overview("Z".repeat(43))).toEqual({ status: "unauthenticated" });
  } finally {
    await db.close();
  }
});

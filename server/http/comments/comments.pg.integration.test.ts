import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createCommentDelay, createTeacherNotes, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const WORK = "doc-a";
// One letter per person of the shared fixture, in the order of their ids.
const TEACHER = "A".repeat(43); // Vesna, teacher of K1
const OTHER_TEACHER = "B".repeat(43); // Marko, teacher of K1 from the day before
const STUDENT = "D".repeat(43); // Ana, the student of doc-a
const OTHER_STUDENT = "E".repeat(43);
const OTHER_TENANT = "I".repeat(43); // Petra, another institution
const ANCHOR = {
  nodeId: "aaaaaaaa-0000-4000-8000-000000000001",
  quote: "primjer",
  prefix: "",
  suffix: "",
  startHint: 0,
  endHint: 7,
};

it("keeps a draft from the student until it is published, keeps the bank private and records a review", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(
      readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
        /^\\ir institution\.inc\r?\n/mu,
        "",
      ),
    );
    await db.exec(`
      INSERT INTO institution.course_member (course_id, institution_id, user_id, role, member_from)
      VALUES ('00000000-0000-4000-8000-0000000000c1', '00000000-0000-4000-8000-00000000000a',
              '00000000-0000-4000-8000-000000000102', 'teacher', now() - interval '1 day')`);
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
    const delay = createCommentDelay(withActor);
    const notes = createTeacherNotes(withActor);
    /** What a reader gets from the one comment reading of the work. */
    const visible = async (token: string) =>
      (
        await withActor(token, (tx) =>
          tx.query<{ body: string }>(
            "SELECT body FROM collaboration.list_comments($1) ORDER BY comment_position",
            [WORK],
          ),
        )
      ).rows.map((r) => r.body);

    // D-51: a draft is the author's alone.
    const opened = await delay.createDraft(TEACHER, WORK, "Izmišljena napomena o izvoru.", ANCHOR);
    expect(opened).toMatchObject({ status: "ok" });
    const threadId = "threadId" in opened ? opened.threadId : "";
    expect(await delay.replyDraft(TEACHER, WORK, threadId, "Izmišljen nastavak.")).toMatchObject({
      status: "ok",
    });
    expect(await visible(STUDENT)).toEqual([]);
    expect(await visible(TEACHER)).toEqual([]);
    expect(await delay.listDrafts(TEACHER, WORK)).toMatchObject({
      status: "ok",
      drafts: [{ position: 1 }, { position: 2 }],
    });
    expect(await delay.listDrafts(OTHER_TEACHER, WORK)).toEqual({ status: "ok", drafts: [] });
    expect(await delay.listDrafts(STUDENT, WORK)).toEqual({ status: "not_found" });
    expect(await delay.createDraft(STUDENT, WORK, "Tekst.", ANCHOR)).toEqual({
      status: "not_found",
    });
    expect(await delay.replyDraft(STUDENT, WORK, threadId, "Tekst.")).toEqual({
      status: "not_found",
    });
    expect(await delay.createDraft(TEACHER, WORK, "   ", ANCHOR)).toEqual({ status: "invalid" });

    // Publishing gives both comments at once; the student can then reply.
    expect(await delay.publish(OTHER_TEACHER, WORK)).toEqual({ status: "conflict" });
    expect(await delay.publish(STUDENT, WORK)).toEqual({ status: "not_found" });
    expect(await delay.publish(TEACHER, WORK)).toEqual({ status: "ok", published: 2 });
    expect(await visible(STUDENT)).toEqual([
      "Izmišljena napomena o izvoru.",
      "Izmišljen nastavak.",
    ]);
    expect(await delay.listDrafts(TEACHER, WORK)).toEqual({ status: "ok", drafts: [] });
    expect(await delay.publish(TEACHER, WORK)).toEqual({ status: "conflict" });

    // A discarded draft leaves nothing, not even its thread.
    const second = await delay.createDraft(TEACHER, WORK, "Predomislila sam se.", ANCHOR);
    const secondId = "threadId" in second ? second.threadId : "";
    const drafts = await delay.listDrafts(TEACHER, WORK);
    const commentId = "drafts" in drafts ? drafts.drafts[0]!.commentId : "";
    expect(await delay.discardDraft(OTHER_TEACHER, commentId)).toEqual({ status: "not_found" });
    expect(await delay.discardDraft(TEACHER, commentId)).toEqual({ status: "ok" });
    expect(await delay.discardDraft(TEACHER, commentId)).toEqual({ status: "not_found" });
    expect(
      (
        await db.query<{ n: string }>(
          "SELECT count(*)::text AS n FROM collaboration.comment_thread WHERE id = $1",
          [secondId],
        )
      ).rows[0]!.n,
    ).toBe("0");

    // N-03: the bank belongs to its teacher.
    expect(await notes.createTemplate(TEACHER, "Navedite izvor.", "must")).toMatchObject({
      status: "created",
    });
    expect(await notes.listTemplates(TEACHER)).toMatchObject({
      status: "ok",
      items: [{ body: "Navedite izvor.", kind: "must" }],
    });
    for (const other of [OTHER_TEACHER, STUDENT, OTHER_STUDENT, OTHER_TENANT]) {
      expect(await notes.listTemplates(other)).toEqual({ status: "ok", items: [] });
    }
    expect(await notes.createTemplate(STUDENT, "Tekst.", "must")).toEqual({
      status: "not_found",
    });

    // N-05: the reviewed revision is the teacher's own.
    expect(await delay.markReviewed(TEACHER, WORK)).toEqual({ status: "conflict" });
    await db.exec(`
      SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
      SELECT 'doc-a', institution_id, 1, 0, principal_id, current_content_hash FROM evidence.document WHERE id = 'doc-a';
      RESET ROLE;`);
    await db.exec(`
      SET LOCAL ROLE ductus_evidence;
      UPDATE evidence.document SET current_revision = 1 WHERE id = 'doc-a';
      RESET ROLE;`);
    expect(await delay.reviewState(TEACHER, WORK)).toEqual({
      status: "ok",
      reviewedRevision: null,
      currentRevision: 1,
    });
    expect(await delay.markReviewed(TEACHER, WORK)).toMatchObject({
      status: "ok",
      reviewedRevision: 1,
    });
    expect(await delay.reviewState(TEACHER, WORK)).toMatchObject({ reviewedRevision: 1 });
    expect(await delay.reviewState(OTHER_TEACHER, WORK)).toMatchObject({ reviewedRevision: null });
    expect(await delay.reviewState(STUDENT, WORK)).toEqual({ status: "not_found" });
    expect(await delay.markReviewed(STUDENT, WORK)).toEqual({ status: "not_found" });
    expect(await delay.markReviewed("Z".repeat(43), WORK)).toEqual({ status: "unauthenticated" });
  } finally {
    await db.close();
  }
});

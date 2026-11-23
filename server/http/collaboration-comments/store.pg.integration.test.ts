import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";

import { execute } from "./store.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const NODE = "0f1e2d3c-4b5a-4968-8776-655443322110";
const SNAPSHOT = `{"nodes":[{"children":[{"marks":[],"text":"Sintetički tekst","type":"text"}],"id":"${NODE}","type":"paragraph"}],"schemaVersion":1}`;
const WORK = { documentId: "doc-a" };
const STUDENT = "D".repeat(43);
const TEACHER = "A".repeat(43);
const OTHER_STUDENT = "E".repeat(43);
const OTHER_TENANT = "I".repeat(43);

it("stores shared comments under ductus_app without changing the work or its revision", async () => {
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
    const published = await withActor(STUDENT, (tx) =>
      tx.query("SELECT * FROM collaboration.publish_live_state($1, NULL, $2)", [
        WORK.documentId,
        SNAPSHOT,
      ]),
    );
    expect(published.rows).toMatchObject([{ outcome: "accepted" }]);
    const evidence = () =>
      db.query(
        `SELECT row_to_json(d) AS document, row_to_json(r) AS revision
           FROM evidence.document d JOIN evidence.document_revision r ON r.document_id = d.id
          WHERE d.id = $1 ORDER BY r.revision`,
        [WORK.documentId],
      );
    // Revision 1 of Ana's work, as 231-comment-revision.sql commits it.
    await db.exec(
      "SELECT pg_temp.call('ana', 'pkg-a', 'request-1', pg_temp.descriptor(), 0, repeat('a', 64)," +
        " repeat('d', 64), repeat('b', 64))",
    );
    const before = (await evidence()).rows;
    const anchor = {
      nodeId: NODE,
      quote: "tekst",
      startHint: 11,
      endHint: 16,
      prefix: " ",
      suffix: "",
    };
    // null leaves the revision out of the body.
    const create = (value: typeof anchor | null, revision: number | null = 1) =>
      withActor(TEACHER, (tx) =>
        execute(tx, "create", {
          ...WORK,
          body: "Dopuni izvor.",
          anchor: value,
          ...(revision === null ? {} : { revision }),
        }),
      );
    expect(await create({ ...anchor, quote: "nacrt" })).toEqual({ status: 409 });
    expect((await create(anchor)).status).toBe(200);
    expect((await create(null)).status).toBe(200);
    // A teacher must name a revision that exists (INT-15-SRV).
    for (const revision of [null, 2]) {
      await expect(create(null, revision)).rejects.toMatchObject({ code: "ZD422" });
    }

    const list = (token: string) => withActor(token, (tx) => execute(tx, "list", WORK));
    for (const token of [TEACHER, STUDENT]) {
      const comment = { body: "Dopuni izvor.", authorRole: "teacher", isOwn: token === TEACHER };
      const result = await list(token);
      expect(result).toMatchObject({
        status: 200,
        body: {
          comments: expect.arrayContaining([
            expect.objectContaining({ ...comment, anchor, revision: 1 }),
            expect.objectContaining({ ...comment, anchor: null, revision: 1 }),
          ]),
        },
      });
    }
    await expect(list(OTHER_STUDENT)).rejects.toMatchObject({ code: "ZD403" });
    await expect(list(OTHER_TENANT)).rejects.toMatchObject({ code: "ZD403" });
    expect((await evidence()).rows).toEqual(before);
    const live = await withActor(STUDENT, (tx) =>
      tx.query("SELECT body FROM collaboration.read_live_state($1, NULL)", [WORK.documentId]),
    );
    expect(live.rows).toEqual([{ body: SNAPSHOT }]);
  } finally {
    await db.close();
  }
});

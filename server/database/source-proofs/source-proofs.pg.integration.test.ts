// The source proof port over the migrated database (SRV-1102): a proof read
// back belongs to the same source and page and its JPEG bytes come back
// exactly, through bytea; another student of the course reaches nothing of
// it; a whole PDF never reaches the RPC. Fixture people only.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../index.ts";

import { createSourceProofs } from "./source-proofs.ts";

const INSTITUTION_FIXTURE = new URL(
  "../../../db/main/tests/fixtures/institution.inc",
  import.meta.url,
);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_SOURCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x0d, 0x0a, 0xff, 0xd9]);
const PDF = Buffer.from("%PDF-1.7\n%%EOF\n");
const record = (id: string) =>
  JSON.stringify({
    id,
    type: "book",
    year: 2024,
    authors: [{ kind: "person", family: "Izmišljenić", given: "Mara" }],
    title: "Kućno kompostiranje",
    place: "Zagreb",
    publisher: "Izmišljena naklada",
  });

it("attaches a proof and reads it back, bytes and all, only as the student of the work", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(INSTITUTION_FIXTURE, "utf8"));
    const withActor: WithActor = async (token, run) => {
      // The fixture wraps each query in a savepoint inside its rollback-only transaction.
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
    for (const id of [SOURCE, OTHER_SOURCE]) {
      await withActor(ANA, (tx) =>
        tx.query("SELECT 1 FROM institution.save_work_source($1::uuid, $2::jsonb)", [
          ASSIGNMENT,
          record(id),
        ]),
      );
    }
    const proofs = createSourceProofs(withActor);
    const input = { assignmentId: ASSIGNMENT, sourceId: SOURCE, page: "14", image: JPEG };
    const added = await proofs.add(ANA, { ...input, note: "Izmišljena\nbilješka." });
    expect(added).toMatchObject({
      status: "added",
      proof: { page: "14", note: "Izmišljena\nbilješka." },
    });
    if (added.status !== "added") throw new Error("the fixture proof was not added");

    expect(await proofs.list(ANA, ASSIGNMENT, SOURCE)).toEqual({
      status: "read",
      proofs: [added.proof],
    });
    expect(await proofs.list(ANA, ASSIGNMENT, OTHER_SOURCE)).toEqual({
      status: "read",
      proofs: [],
    });
    const image = await proofs.image(ANA, ASSIGNMENT, SOURCE, added.proof.id);
    expect(image.status === "read" && image.image.equals(JPEG)).toBe(true);
    expect(await proofs.image(ANA, ASSIGNMENT, OTHER_SOURCE, added.proof.id)).toEqual({
      status: "not_found",
    });

    expect(await proofs.list(DORA, ASSIGNMENT, SOURCE)).toEqual({ status: "not_found" });
    expect(await proofs.image(DORA, ASSIGNMENT, SOURCE, added.proof.id)).toEqual({
      status: "not_found",
    });
    expect(await proofs.add(DORA, { ...input, note: null })).toEqual({ status: "not_found" });
    expect(await proofs.add(ANA, { ...input, note: null, image: PDF })).toEqual({
      status: "invalid_input",
    });
  } finally {
    await db.close();
  }
});

// SRV-NF6-SIFRA over a real database (20261217150000, 20261217160000): the port of the sealed
// note to self and the wrapped key, as the routes call it. The rules
// themselves are db/main/tests/242-self-note-sealed.sql; this checks that the
// bytes are stored and answered unchanged, that another person reads nothing
// and that no text of the note is in the tables. Invented personas and bytes.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { createSelfNoteSealed, type WithActor } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const WORK = "doc-a";
const STUDENT = "D".repeat(43);
const TEACHER = "A".repeat(43);
const OTHER_STUDENT = "E".repeat(43);
const KEY_ID = "6f1e2d3c-4b5a-4968-8776-6554433221a1";
const b64 = (length: number) => randomBytes(length).toString("base64url");
const wrap = () => ({ salt: b64(16), iv: b64(12), ct: b64(48) });

it("keeps the sealed note and the wrapped key byte for byte, for their owner alone", async () => {
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
    const sealed = createSelfNoteSealed(withActor);
    const key = {
      v: 1 as const,
      keyId: KEY_ID,
      kdf: { alg: "PBKDF2-SHA-256" as const, iterations: 600000 },
      phrase: wrap(),
      recovery: wrap(),
    };
    const note = { v: 1 as const, keyId: KEY_ID, iv: b64(12), ct: b64(1296) };

    expect(await sealed.readKey(STUDENT)).toEqual({ status: "ok", key: null });
    expect(await sealed.writeNote(STUDENT, WORK, note)).toEqual({ status: "conflict" });
    const set = await sealed.writeKey(STUDENT, key, null);
    expect(set).toMatchObject({ status: "ok", key: { ...key, version: 1 } });
    expect(await sealed.readKey(STUDENT)).toEqual(set);
    expect(await sealed.writeKey(STUDENT, key, null)).toEqual({ status: "conflict" });
    const rewrapped = await sealed.writeKey(STUDENT, { ...key, phrase: wrap() }, 1);
    expect(rewrapped).toMatchObject({ status: "ok", key: { keyId: KEY_ID, version: 2 } });

    const written = await sealed.writeNote(STUDENT, WORK, note);
    expect(written).toMatchObject({ status: "ok", state: { note: { sealed: note } } });
    expect(await sealed.readNote(STUDENT, WORK)).toEqual(written);
    const stored = await db.query<{ iv: Buffer; ct: Buffer }>(
      "SELECT note_iv AS iv, note_ct AS ct FROM collaboration.work_self_note WHERE document_id = $1",
      [WORK],
    );
    expect(stored.rows[0]!.iv.toString("base64url")).toBe(note.iv);
    expect(stored.rows[0]!.ct.toString("base64url")).toBe(note.ct);
    expect(
      await sealed.writeNote(STUDENT, WORK, { ...note, ct: `${note.ct.slice(0, -1)}=` }),
    ).toEqual({ status: "invalid" });

    // The teacher of the work, another student and no session read nothing.
    expect(await sealed.readNote(TEACHER, WORK)).toEqual({ status: "not_found" });
    expect(await sealed.writeNote(OTHER_STUDENT, WORK, note)).toEqual({ status: "not_found" });
    expect(await sealed.readKey(OTHER_STUDENT)).toEqual({ status: "ok", key: null });
    expect(await sealed.readKey("Z".repeat(43))).toEqual({ status: "unauthenticated" });

    // No column of either table holds text but the work id.
    const columns = await db.query<{ table: string; column: string }>(
      `SELECT table_name AS "table", column_name AS "column" FROM information_schema.columns
        WHERE table_schema = 'collaboration' AND table_name IN ('work_self_note', 'self_note_key')
          AND data_type IN ('text', 'character varying', 'json')`,
    );
    expect(columns.rows).toEqual([{ table: "work_self_note", column: "document_id" }]);

    // SRV-NF6-SIFRA-2 (S2): a stale version or another key deletes nothing.
    const OTHER_KEY = "6f1e2d3c-4b5a-4968-8776-6554433221a2";
    expect(await sealed.deleteKeyChecked(STUDENT, KEY_ID, 1)).toEqual({ status: "conflict" });
    expect(await sealed.deleteKeyChecked(STUDENT, OTHER_KEY, null)).toEqual({
      status: "conflict",
    });
    expect(await sealed.deleteKeyChecked(OTHER_STUDENT, KEY_ID, 2)).toEqual({
      status: "conflict",
    });
    expect(await sealed.readNote(STUDENT, WORK)).toEqual(written);
    expect(await sealed.deleteKeyChecked(STUDENT, KEY_ID, 2)).toEqual({ status: "ok", key: null });
    expect(await sealed.readNote(STUDENT, WORK)).toEqual({
      status: "ok",
      state: { note: null, readingPlace: null },
    });
    expect(await sealed.deleteKeyChecked(STUDENT, KEY_ID, null)).toEqual({ status: "conflict" });

    expect(await sealed.writeKey(STUDENT, key, null)).toMatchObject({ status: "ok" });
    expect(await sealed.deleteKey(STUDENT)).toEqual({ status: "ok", key: null });
    expect(await sealed.readKey(STUDENT)).toEqual({ status: "ok", key: null });
  } finally {
    await db.close();
  }
});

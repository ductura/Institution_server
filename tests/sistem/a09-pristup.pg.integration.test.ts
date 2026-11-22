// INT-19 (A09) over the migrated PostgreSQL: another student's work and a
// person of another institution are refused through the real HTTP app (the
// same 404 as an unknown work, C-23) and through the application role itself
// (SET LOCAL ROLE ductus_app with the session token set as the server sets
// it, inside the rollback-only test transaction): no row or a refusal. After
// the teacher role is revoked, or the student is removed from the course, the
// same actor is refused both ways. Fixture (db/main/tests/fixtures): Ana (D)
// owns doc-a on Z1 in K1 of fak-a, where Vesna (A) teaches and Dora (E) is
// another student; Iva (C) is fak-a's admin; Petra (I) teaches K3 and Tomo (J)
// owns doc-b on Z3, both in fak-b. Every person and work is invented.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import type { WithActor } from "../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createWorkMessagesRoutesFor,
  startServer,
} from "../../server/http/index.ts";
import { createTestDatabase, type TestDatabase } from "../../test-support/database/index.ts";

const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const VESNA = "A".repeat(43);
const IVA = "C".repeat(43);
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const PETRA = "I".repeat(43);
const TOMO = "J".repeat(43);
const VESNA_ID = "00000000-0000-4000-8000-000000000101";
const ANA_ID = "00000000-0000-4000-8000-000000000104";
const K1 = "00000000-0000-4000-8000-0000000000c1";
const Z1 = "00000000-0000-4000-8000-0000000000a1";

async function prepare(db: TestDatabase) {
  await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
  await db.exec(
    readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
      /^\\ir institution\.inc\r?\n/mu,
      "",
    ),
  );
}

/** The app login: the session token, then every statement as ductus_app. */
function appActor(db: TestDatabase): WithActor {
  return async (token, run) => {
    await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
    await db.exec("SET LOCAL ROLE ductus_app");
    try {
      return await run({
        async query<Row>(sql: string, values?: readonly unknown[]) {
          const { rows } = await db.query<Row>(sql, [...(values ?? [])]);
          return { rows, rowCount: rows.length };
        },
      });
    } finally {
      await db.exec("RESET ROLE");
    }
  };
}

/** What the application role answers one actor: the row count, or the SQLSTATE of its refusal. */
function rls(withActor: WithActor) {
  const answer = (token: string, sql: string, values: unknown[] = []) =>
    withActor(token, async (tx) => (await tx.query(sql, values)).rows.length).catch(
      (error: { code?: string }) => error.code ?? "error",
    );
  return {
    document: (token: string, id: string) =>
      answer(token, "SELECT 1 FROM evidence.document WHERE id = $1", [id]),
    revisions: (token: string, id: string) =>
      answer(token, "SELECT 1 FROM evidence.document_revision WHERE document_id = $1", [id]),
    project: (token: string, id: string) =>
      answer(token, "SELECT 1 FROM evidence.project WHERE id = $1", [id]),
    assignment: (token: string) =>
      answer(token, "SELECT 1 FROM institution.assignment WHERE id = $1", [Z1]),
    course: (token: string) =>
      answer(token, "SELECT 1 FROM institution.course WHERE id = $1", [K1]),
    messagesTable: (token: string, id: string) =>
      answer(token, "SELECT 1 FROM collaboration.work_message WHERE document_id = $1", [id]),
    messages: (token: string, id: string) =>
      answer(token, "SELECT 1 FROM collaboration.list_work_messages($1)", [id]),
    write: (token: string, id: string) =>
      answer(token, "SELECT 1 FROM collaboration.create_work_message($1, $2)", [
        id,
        "Izmišljena poruka.",
      ]),
  };
}

async function withServer(
  withActor: WithActor,
  run: (http: {
    get: (token: string, work: string) => Promise<number>;
    post: (token: string, work: string) => Promise<number>;
  }) => Promise<void>,
) {
  const server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createWorkMessagesRoutesFor({ withActor }),
  });
  const url = (work: string) =>
    `http://127.0.0.1:${server.port}/api/v1/works/${encodeURIComponent(work)}/messages`;
  try {
    await run({
      async get(token, work) {
        const response = await fetch(url(work), {
          headers: { cookie: `__Host-ductus_session=${token}` },
        });
        await response.arrayBuffer();
        return response.status;
      },
      async post(token, work) {
        const response = await fetch(url(work), {
          method: "POST",
          headers: {
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            cookie: `__Host-ductus_session=${token}`,
          },
          body: JSON.stringify({ text: "Izmišljena poruka." }),
        });
        await response.arrayBuffer();
        return response.status;
      },
    });
  } finally {
    await server.close();
  }
}

async function messageCount(db: TestDatabase): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM collaboration.work_message",
  );
  return rows[0]!.n;
}

it("A09: tuđi rad i druga ustanova odbijeni su kroz HTTP i kroz ulogu ductus_app (RLS)", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await prepare(db);
    const withActor = appActor(db);
    const app = rls(withActor);

    await withServer(withActor, async (http) => {
      // The relation opens the work: its student and the teacher of its assignment.
      expect(await http.get(ANA, "doc-a")).toBe(200);
      expect(await http.get(VESNA, "doc-a")).toBe(200);
      expect(await http.post(ANA, "doc-a")).toBe(201);
      expect(await http.get(TOMO, "doc-b")).toBe(200);
      const written = await messageCount(db);
      expect(written).toBe(1);

      // Another student of the same course, a teacher and a student of
      // another institution: the same 404 as a work that does not exist.
      for (const token of [DORA, PETRA, TOMO]) {
        expect(await http.get(token, "doc-a")).toBe(404);
        expect(await http.post(token, "doc-a")).toBe(404);
      }
      expect(await http.get(ANA, "doc-b")).toBe(404);
      expect(await http.get(VESNA, "doc-b")).toBe(404);
      expect(await http.get(ANA, "doc-nepostojeci")).toBe(404);
      expect(await messageCount(db)).toBe(written);
    });

    // The owner sees her work's rows through RLS; nobody else does, the
    // teacher of the assignment included (the evidence tables are the owner's).
    expect(await app.document(ANA, "doc-a")).toBe(1);
    expect(await app.revisions(ANA, "doc-a")).toBe(1);
    expect(await app.project(ANA, "project-a")).toBe(1);
    expect(await app.document(TOMO, "doc-b")).toBe(1);
    for (const token of [DORA, VESNA, PETRA, TOMO]) {
      expect(await app.document(token, "doc-a")).toBe(0);
      expect(await app.revisions(token, "doc-a")).toBe(0);
      expect(await app.project(token, "project-a")).toBe(0);
    }
    expect(await app.document(ANA, "doc-b")).toBe(0);

    // The assignment and the course: the relation's people only.
    for (const token of [ANA, DORA, VESNA]) {
      expect(await app.assignment(token)).toBe(1);
      expect(await app.course(token)).toBe(1);
    }
    for (const token of [PETRA, TOMO]) {
      expect(await app.assignment(token)).toBe(0);
      expect(await app.course(token)).toBe(0);
    }

    // The messages: the table is closed to the app role; its functions ask the relation.
    expect(await app.messagesTable(ANA, "doc-a")).toBe("42501");
    expect(await app.messages(ANA, "doc-a")).toBe(1);
    expect(await app.messages(VESNA, "doc-a")).toBe(1);
    for (const token of [DORA, PETRA, TOMO]) {
      expect(await app.messages(token, "doc-a")).toBe("ZD403");
      expect(await app.write(token, "doc-a")).toBe("ZD403");
    }
    expect(await messageCount(db)).toBe(1);
  } finally {
    await db.close();
  }
});

it("A09: nakon ukidanja uloge nastavnika isti je nastavnik odbijen kroz HTTP i kroz RLS", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await prepare(db);
    const withActor = appActor(db);
    const app = rls(withActor);

    await withServer(withActor, async (http) => {
      // Before: Vesna teaches Z1 and reaches Ana's work.
      expect(await http.get(VESNA, "doc-a")).toBe(200);
      expect(await app.assignment(VESNA)).toBe(1);
      expect(await app.course(VESNA)).toBe(1);
      expect(await app.messages(VESNA, "doc-a")).toBe(0);

      // Only the institution's admin may revoke the role; the teacher herself may not.
      expect(
        await withActor(VESNA, (tx) =>
          tx.query("SELECT institution.revoke_teacher_role($1)", [VESNA_ID]),
        ).catch((error: { code?: string }) => error.code),
      ).toBe("ZD403");
      await withActor(IVA, (tx) =>
        tx.query("SELECT institution.revoke_teacher_role($1)", [VESNA_ID]),
      );
      const revoked = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM institution.institution_role
          WHERE user_id = $1 AND role = 'teacher' AND revoked_at IS NOT NULL`,
        [VESNA_ID],
      );
      expect(revoked.rows[0]!.n).toBe(1);

      // After: the same session, the same 404 as a stranger, and no row through RLS.
      expect(await http.get(VESNA, "doc-a")).toBe(404);
      const before = await messageCount(db);
      expect(await http.post(VESNA, "doc-a")).toBe(404);
      expect(await messageCount(db)).toBe(before);
      expect(await app.assignment(VESNA)).toBe(0);
      expect(await app.course(VESNA)).toBe(0);
      expect(await app.document(VESNA, "doc-a")).toBe(0);
      expect(await app.messages(VESNA, "doc-a")).toBe("ZD403");
      expect(await app.write(VESNA, "doc-a")).toBe("ZD403");

      // The student's own relation is untouched.
      expect(await http.get(ANA, "doc-a")).toBe(200);
      expect(await app.assignment(ANA)).toBe(1);
    });
  } finally {
    await db.close();
  }
});

it("A09: nakon uklanjanja studenta iz kolegija ista je studentica odbijena kroz HTTP i kroz RLS", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await prepare(db);
    const withActor = appActor(db);
    const app = rls(withActor);

    await withServer(withActor, async (http) => {
      expect(await http.get(ANA, "doc-a")).toBe(200);
      expect(await app.assignment(ANA)).toBe(1);
      expect(await app.course(ANA)).toBe(1);

      // Another student may not remove her; the course's teacher may.
      expect(
        await withActor(DORA, (tx) =>
          tx.query("SELECT institution.remove_student($1, $2)", [K1, ANA_ID]),
        ).catch((error: { code?: string }) => error.code),
      ).toBe("ZD403");
      const removed = await withActor(VESNA, (tx) =>
        tx.query<{ removed: boolean }>("SELECT institution.remove_student($1, $2) AS removed", [
          K1,
          ANA_ID,
        ]),
      );
      expect(removed.rows).toEqual([{ removed: true }]);

      // After: the work's conversation and the course are closed to her.
      expect(await http.get(ANA, "doc-a")).toBe(404);
      const before = await messageCount(db);
      expect(await http.post(ANA, "doc-a")).toBe(404);
      expect(await messageCount(db)).toBe(before);
      expect(await app.assignment(ANA)).toBe(0);
      expect(await app.course(ANA)).toBe(0);
      expect(await app.messages(ANA, "doc-a")).toBe("ZD403");
      expect(await app.write(ANA, "doc-a")).toBe("ZD403");
      // Her own evidence rows stay hers by ownership (the record of her work is kept).
      expect(await app.document(ANA, "doc-a")).toBe(1);

      // The teacher keeps hers.
      expect(await http.get(VESNA, "doc-a")).toBe(200);
    });
  } finally {
    await db.close();
  }
});

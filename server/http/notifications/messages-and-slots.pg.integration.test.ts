import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createNotificationsRoutesFor } from "./index.ts";

// F4-MEN-R10-SRV (MEN-05) over the live database roles: a message and a slot that waits for an
// answer tell the other side of the work, through the writes themselves, and the new list shows
// them to that side only. Fixture tokens of institution.inc: A Vesna (teacher of K1), B Marko
// (teacher of K2), D Ana and E Dora (students of fak-a), J Tomo (fak-b). Every person and text is
// invented.
const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";

it("tells the other side of a work of a message and of a slot, and nobody else", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(`SET CONSTRAINTS ALL DEFERRED;
      SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.domain (id, institution_id, region)
      VALUES ('00000000-0000-4000-8000-0000000000e1', pg_temp.id('fak_a'), 'eu-central-1');
      INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
      VALUES ('project-a', pg_temp.id('fak_a'), pg_temp.id('z1'), pg_temp.id('ana'));
      INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_content_hash)
      VALUES ('doc-a', pg_temp.id('fak_a'), 'project-a', pg_temp.id('ana'), repeat('a', 64));
      INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
      VALUES ('doc-a', pg_temp.id('fak_a'), 0, NULL, pg_temp.id('ana'), repeat('a', 64)),
             ('doc-a', pg_temp.id('fak_a'), 1, 0, pg_temp.id('ana'), repeat('a', 64));
      SET CONSTRAINTS ALL IMMEDIATE;
      RESET ROLE;`);

    let queue: Promise<unknown> = Promise.resolve();
    const withOneActor: WithActor = async (token, run) => {
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
    const withActor: WithActor = (token, run) => {
      const next = queue.then(() => withOneActor(token, run));
      queue = next.catch(() => undefined);
      return next;
    };
    const token = (actor: string) => actor.repeat(43);
    const write = (actor: string, sql: string, args: unknown[] = []) =>
      withActor(token(actor), (tx) => tx.query(sql, args));

    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createNotificationsRoutesFor({ withActor }),
    });
    try {
      const list = async (actor: string, path = "messages-and-slots") => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/v1/notifications/${path}`,
          {
            headers: { cookie: `__Host-ductus_session=${token(actor)}` },
          },
        );
        return {
          status: response.status,
          body: (await response.json()) as {
            notifications: {
              id: string;
              kind: string;
              documentId: string;
              slotId: string | null;
            }[];
          },
        };
      };
      const kinds = async (actor: string) =>
        (await list(actor)).body.notifications.map((n) => n.kind).sort();

      await write("D", "SELECT * FROM collaboration.create_work_message('doc-a', $1)", [
        "Izmišljeno pitanje.",
      ]);
      expect(await kinds("A")).toEqual(["message_posted"]);
      for (const other of ["D", "E", "B", "J"]) expect(await kinds(other)).toEqual([]);

      await write("A", "SELECT * FROM collaboration.create_work_message('doc-a', $1)", [
        "Izmišljen odgovor.",
      ]);
      expect(await kinds("D")).toEqual(["message_posted"]);

      const slot = await write(
        "D",
        "SELECT id FROM institution.request_consultation_slot('doc-a', now() + interval '3 days')",
      );
      const slotId = (slot.rows[0] as { id: string }).id;
      const teacher = await list("A");
      expect(teacher.body.notifications.map((n) => n.kind).sort()).toEqual([
        "message_posted",
        "slot_requested",
      ]);
      expect(teacher.body.notifications.find((n) => n.kind === "slot_requested")).toMatchObject({
        documentId: "doc-a",
        slotId,
      });
      expect(await kinds("D")).toEqual(["message_posted"]);

      await write(
        "A",
        "SELECT * FROM institution.act_on_consultation_slot('doc-a', $1, 'counter', now() + interval '4 days')",
        [slotId],
      );
      expect(await kinds("D")).toEqual(["message_posted", "slot_proposed"]);
      expect(await kinds("A")).toEqual(["message_posted", "slot_requested"]);
      for (const other of ["E", "B", "J"]) expect(await kinds(other)).toEqual([]);

      // The old inbox keeps to its own kinds; a notification is marked read through the old route.
      const inbox = await fetch(`http://127.0.0.1:${server.port}/api/v1/notifications`, {
        headers: { cookie: `__Host-ductus_session=${token("D")}` },
      });
      expect(inbox.status).toBe(200);
      const old = ((await inbox.json()) as { notifications: { kind: string }[] }).notifications;
      expect(old.map((n) => n.kind)).not.toContain("message_posted");
      expect(old.map((n) => n.kind)).not.toContain("slot_proposed");
      const mine = (await list("D")).body.notifications[0]!;
      const read = (actor: string) =>
        fetch(`http://127.0.0.1:${server.port}/api/v1/notifications/${mine.id}/read`, {
          method: "POST",
          headers: {
            cookie: `__Host-ductus_session=${token(actor)}`,
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
          },
        });
      expect((await read("E")).status).toBe(404);
      expect((await read("D")).status).toBe(204);
      expect((await list("D")).body.notifications.find((n) => n.id === mine.id) !== undefined).toBe(
        true,
      );
      // Another account's notification is no cursor: it reads as not found.
      expect(
        (
          await fetch(
            `http://127.0.0.1:${server.port}/api/v1/notifications/messages-and-slots?before=${mine.id}`,
            { headers: { cookie: `__Host-ductus_session=${token("E")}` } },
          )
        ).status,
      ).toBe(404);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
}, 60_000);

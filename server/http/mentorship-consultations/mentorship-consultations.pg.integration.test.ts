import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";
import { createConsultationRecordRoutesFor } from "../consultation-records/index.ts";
import { createNotificationsRoutesFor } from "../notifications/index.ts";

import { createMentorshipConsultationRoutesFor } from "./index.ts";

// SRV-MENTOR-1 acceptance over the live database roles (NF-6: MK-7, MK-3,
// MK-10, MK-5). Fixture tokens of institution.inc: A Vesna (teacher of K1),
// B Marko (teacher of K2), D Ana and E Dora (students of fak-a), I Petra
// (teacher of fak-b), X an expired session. Every person and text is invented.
const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";

it("opens a mentorship, moves its slots and keeps its agreed tasks only along relations", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    for (const fixture of ["institution.inc", "mentorship.inc"]) {
      await db.exec(readFileSync(new URL(fixture, FIXTURES), "utf8"));
    }
    await db.exec(`INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
      VALUES (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Izmišljena')`);
    await db.exec(`SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.domain (id, institution_id, region)
      VALUES (gen_random_uuid(), pg_temp.id('fak_a'), 'eu-central-1');
      RESET ROLE;`);
    const dora = (await db.query<{ id: string }>("SELECT pg_temp.id('dora')::text AS id")).rows[0]!
      .id;

    // One connection: calls, the routes' fire-and-forget activity write included, run one at a time.
    let queue: Promise<unknown> = Promise.resolve();
    const withActor: WithActor = (token, run) => {
      const next = queue.then(() => withOneActor(token, run));
      queue = next.catch(() => undefined);
      return next;
    };
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
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [
        ...createMentorshipConsultationRoutesFor({ withActor }),
        ...createNotificationsRoutesFor({ withActor }),
        ...createConsultationRecordRoutesFor({ withActor }),
      ],
    });
    try {
      const call = async (actor: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/${path}`, {
          method,
          headers: {
            cookie: `__Host-ductus_session=${actor.repeat(43)}`,
            ...(body === undefined
              ? {}
              : {
                  origin: ORIGIN,
                  "sec-fetch-site": "same-origin",
                  "content-type": "application/json",
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };

      // (a) MK-7: only a confirmed teacher opens; Dora is told and sees it.
      const opening = {
        studentId: dora.toUpperCase(),
        workType: "master_thesis",
        topic: "Izmišljena tema o vodi",
      };
      expect((await call("D", "POST", "mentorships", opening)).status).toBe(404);
      expect((await call("I", "POST", "mentorships", opening)).status).toBe(404);
      const opened = await call("A", "POST", "mentorships", opening);
      expect(opened.status).toBe(201);
      const mentorshipId = opened.body.mentorshipId as string;
      expect((await call("A", "POST", "mentorships", opening)).status).toBe(409);
      expect(
        (await call("A", "POST", "mentorships", { ...opening, topic: "‮Izmišljeno" })).status,
      ).toBe(422);

      const own = await call("E", "GET", "student/mentorships");
      expect(own.status).toBe(200);
      const mine = (own.body.mentorships as Record<string, unknown>[]).find(
        (m) => m.mentorshipId === mentorshipId,
      );
      expect(mine).toMatchObject({
        workType: "master_thesis",
        topic: "Izmišljena tema o vodi",
        mentorName: { givenName: "Vesna", familyName: "Izmišljena" },
        openedBy: "teacher",
      });
      expect(JSON.stringify((await call("D", "GET", "student/mentorships")).body)).not.toContain(
        mentorshipId,
      );
      expect((await call("A", "GET", "student/mentorships")).status).toBe(403);

      const notices = await call("E", "GET", "notifications/mentorship-opened");
      expect(notices.body).toEqual({
        notifications: [
          {
            id: expect.any(String),
            targetId: mentorshipId,
            workType: "master_thesis",
            topic: "Izmišljena tema o vodi",
            mentorName: { givenName: "Vesna", familyName: "Izmišljena" },
            createdAt: expect.stringMatching(/Z$/u),
            readAt: null,
          },
        ],
        nextBefore: null,
      });
      expect((await call("D", "GET", "notifications/mentorship-opened")).body).toEqual({
        notifications: [],
        nextBefore: null,
      });
      // The older inbox leaves the new kind out and stays inside its contract.
      const inbox = await call("E", "GET", "notifications");
      expect(inbox.status).toBe(200);
      expect(JSON.stringify(inbox.body)).not.toContain(mentorshipId);

      // Dora starts the work of the mentorship.
      // She has read the notice of its first version (the fixture writes it as the RPC would).
      await db.query(
        `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
         VALUES ($1, 1, $2, pg_temp.id('fak_a'))`,
        [mine!.assignmentId, dora],
      );
      const started = await db.query<{ id: string }>(
        `SELECT pg_temp.ask('dora', format($$ SELECT document_id FROM app.open_student_work(%L, true) $$, $1::text)) AS id`,
        [mine!.assignmentId],
      );
      const documentId = started.rows[0]!.id;
      expect(documentId).toMatch(/^[0-9a-f-]{36}$/u);
      const work = `works/${encodeURIComponent(documentId)}`;
      // A first revision for the record to name (the fixture writes it as a commit would).
      await db.query(`SELECT set_config('ductura.test_document', $1, true)`, [documentId]);
      await db.exec(`SET LOCAL ROLE ductus_evidence;
        INSERT INTO evidence.document_revision (document_id, institution_id, revision, base_revision, principal_id, content_hash)
        SELECT d.id, d.institution_id, 1, 0, d.principal_id, r.content_hash
          FROM evidence.document d JOIN evidence.document_revision r ON r.document_id = d.id AND r.revision = 0
         WHERE d.id = current_setting('ductura.test_document');
        RESET ROLE;`);

      // (b), (c) MK-3, MK-10: a request with topic and preparation, read by both sides only.
      const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const preparation = {
        text: "Izmišljena priprema.",
        changedParagraphs: 4,
        resolvedComments: 2,
      };
      expect(
        (await call("A", "POST", `${work}/consultation-slot-requests`, { startsAt: soon })).status,
      ).toBe(403);
      const requested = await call("E", "POST", `${work}/consultation-slot-requests`, {
        startsAt: soon,
        topic: "Metoda",
        preparation,
      });
      expect(requested.status).toBe(201);
      expect(requested.body).toMatchObject({
        state: "requested",
        topic: "Metoda",
        closing: null,
        preparation,
      });
      const slot = requested.body.id as string;
      for (const reader of ["A", "E"]) {
        const details = await call(reader, "GET", `${work}/consultation-slot-details`);
        expect(details.body.slots).toEqual([requested.body]);
      }
      for (const stranger of ["B", "D", "I"]) {
        expect((await call(stranger, "GET", `${work}/consultation-slot-details`)).status).toBe(403);
      }
      expect(
        (
          await call("E", "POST", `${work}/consultation-slot-requests`, {
            startsAt: soon,
            preparation: { text: "Bez brojki." },
          })
        ).status,
      ).toBe(422);

      // Withdraw is the student's, decline the teacher's; then the state forbids it.
      expect(
        (
          await call("A", "POST", `${work}/consultation-slots/${slot}/close`, {
            action: "withdraw",
          })
        ).status,
      ).toBe(403);
      const declined = await call("A", "POST", `${work}/consultation-slots/${slot}/close`, {
        action: "decline",
        reason: "Izmišljeni razlog.",
      });
      expect(declined.status).toBe(200);
      expect(declined.body).toMatchObject({
        state: "declined",
        closing: { by: "teacher", reason: "Izmišljeni razlog." },
      });
      expect(
        (
          await call("E", "POST", `${work}/consultation-slots/${slot}/close`, {
            action: "withdraw",
          })
        ).status,
      ).toBe(409);

      // (d) MK-5: only the teacher of the work writes and marks tasks; the student reads.
      const record = await call("A", "POST", `${work}/consultation-records`, {
        heldOn: "2026-11-20",
        revision: 1,
        topic: "Izmišljeni sastanak",
        agreement: "Izmišljeni dogovor.",
      });
      expect(record.status).toBe(201);
      expect(
        (
          await call("E", "POST", `${work}/consultation-records`, {
            heldOn: "2026-11-20",
            revision: 1,
            topic: "Studentov zapis",
            agreement: "",
          })
        ).status,
      ).toBe(404);
      const tasks = `${work}/consultation-records/${record.body.id as string}/tasks`;
      expect((await call("E", "POST", tasks, { text: "Studentov zadatak" })).status).toBe(404);
      const added = await call("A", "POST", tasks, { text: "Dopuniti popis izvora" });
      expect(added.status).toBe(201);
      expect(added.body).toMatchObject({ position: 1, done: false, markedAt: null });
      const mark = `${work}/consultation-tasks/${added.body.id as string}/mark`;
      expect((await call("E", "POST", mark, { done: true })).status).toBe(404);
      const marked = await call("A", "POST", mark, { done: true });
      expect(marked.body).toMatchObject({
        done: true,
        markedAt: expect.stringMatching(/:00\.000Z$/u),
      });
      const listed = await call("E", "GET", `${work}/consultation-tasks`);
      expect(listed.body.tasks).toEqual([marked.body]);
      expect((await call("D", "GET", `${work}/consultation-tasks`)).status).toBe(404);
      expect((await call("X", "GET", `${work}/consultation-tasks`)).status).toBe(401);
    } finally {
      await server.close();
      await queue;
    }
  } finally {
    await db.close();
  }
});

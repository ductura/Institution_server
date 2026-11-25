import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";
import { createMentorshipConsultationRoutesFor } from "../mentorship-consultations/index.ts";

import { createConsultationSlotRoutesFor } from "./index.ts";

// SRV-KONZ-STANJA acceptance over the live database roles: the older slot
// routes take and return a topic, keep to their three states and leave a slot
// closed through work.consultation-slot-close.post out. Fixture tokens of
// institution.inc: A Vesna (teacher of K1), B Marko (teacher of K2), D Ana and
// E Dora (students of fak-a). Every person and text is invented.
const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";

it("keeps the topic of a slot and leaves a closed slot out of the older routes", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    for (const fixture of ["institution.inc", "mentorship.inc"]) {
      await db.exec(readFileSync(new URL(fixture, FIXTURES), "utf8"));
    }
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
        ...createConsultationSlotRoutesFor({ withActor }),
        ...createMentorshipConsultationRoutesFor({ withActor }),
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

      // A work of Dora's under Vesna, as SRV-MENTOR-1 opens one.
      const opened = await call("A", "POST", "mentorships", {
        studentId: dora,
        workType: "master_thesis",
      });
      expect(opened.status).toBe(201);
      const own = await call("E", "GET", "student/mentorships");
      const mine = (own.body.mentorships as Record<string, unknown>[]).find(
        (m) => m.mentorshipId === opened.body.mentorshipId,
      );
      await db.query(
        `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
         VALUES ($1, 1, $2, pg_temp.id('fak_a'))`,
        [mine!.assignmentId, dora],
      );
      const started = await db.query<{ id: string }>(
        `SELECT pg_temp.ask('dora', format($$ SELECT document_id FROM app.open_student_work(%L, true) $$, $1::text)) AS id`,
        [mine!.assignmentId],
      );
      const slots = `works/${encodeURIComponent(started.rows[0]!.id)}/consultation-slots`;

      const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const later = new Date(Date.now() + 4 * 86_400_000).toISOString();
      const topic = "Izmišljena tema: struktura uvoda";

      // A request with a topic and one without; only the owning student asks.
      expect((await call("A", "POST", slots, { startsAt: soon, topic })).status).toBe(403);
      expect((await call("E", "POST", slots, { startsAt: soon, topic: "‮x" })).status).toBe(422);
      const withTopic = await call("E", "POST", slots, { startsAt: soon, topic });
      expect(withTopic.status).toBe(201);
      expect(withTopic.body).toMatchObject({ state: "requested", topic });
      const plain = await call("E", "POST", slots, { startsAt: later });
      expect(plain.status).toBe(201);
      expect(plain.body).toMatchObject({ state: "requested", topic: null });

      // Both sides read the topic; the other teacher and student do not read at all.
      for (const reader of ["A", "E"]) {
        expect((await call(reader, "GET", slots)).body).toEqual({
          slots: [withTopic.body, plain.body],
        });
      }
      for (const stranger of ["B", "D"]) {
        expect((await call(stranger, "GET", slots)).status).toBe(403);
      }

      // The topic stays through counter and accept.
      const countered = await call("A", "PATCH", `${slots}/${withTopic.body.id as string}`, {
        action: "counter",
        startsAt: later,
      });
      expect(countered.body).toMatchObject({ state: "countered", topic, startsAt: later });
      const accepted = await call("E", "PATCH", `${slots}/${withTopic.body.id as string}`, {
        action: "accept",
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ state: "confirmed", topic });

      // Closing moves are not actions of this route.
      expect(
        (await call("E", "PATCH", `${slots}/${plain.body.id as string}`, { action: "withdraw" }))
          .status,
      ).toBe(422);
      // Withdrawn through the close route, the slot leaves this list, and patch is 409.
      const withdrawn = await call("E", "POST", `${slots}/${plain.body.id as string}/close`, {
        action: "withdraw",
      });
      expect(withdrawn.body).toMatchObject({ state: "withdrawn" });
      expect((await call("E", "GET", slots)).body).toEqual({ slots: [accepted.body] });
      expect(
        (await call("A", "PATCH", `${slots}/${plain.body.id as string}`, { action: "confirm" }))
          .status,
      ).toBe(409);
    } finally {
      await server.close();
      await queue;
    }
  } finally {
    await db.close();
  }
});

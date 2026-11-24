import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import type { WithActor } from "../../server/database/index.ts";
import { createDatabases, createLayers, startServer } from "../../server/http/index.ts";
import { createMentorNotesRoutesFor } from "../../server/http/mentor-notes/index.ts";
import { createMentorshipConsultationRoutesFor } from "../../server/http/mentorship-consultations/index.ts";
import { createMentorshipFollowRoutesFor } from "../../server/http/mentorship-follow/index.ts";
import { createSelfNoteSealedRoutesFor } from "../../server/http/self-note-sealed/index.ts";
import { createThesisRoutesFor } from "../../server/http/thesis/index.ts";

// INT-30 (DAN-1126): one mentorship end to end over HTTP on the live database
// roles, after SRV-MENTOR-1, -2 and -3 were merged one by one. The teacher
// opens it, the student starts the work and asks for a slot, the faculty
// publishes a form, the student and the mentor move it, the mentor gives the
// consent, keeps a private note and sees the work in the overview; the
// student keeps a sealed note to self. Along the way the student reads only
// what is hers, nobody but the mentor gives or withdraws the consent, and a
// teacher of another course or another faculty sees nothing. Fixture tokens
// of institution.inc: A Vesna (teacher of K1), B Marko (teacher of K2),
// C Iva (administrator of fak-a), D Ana and E Dora (students of fak-a),
// I Petra (teacher of fak-b), X an expired session. Everything is invented.
const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const KEY_ID = "6f1e2d3c-4b5a-4968-8776-6554433221b7";
const b64 = (length: number) => randomBytes(length).toString("base64url");
const wrap = () => ({ salt: b64(16), iv: b64(12), ct: b64(48) });

it("carries one mentorship from opening to consent along relations only", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    for (const fixture of ["institution.inc", "mentorship.inc"]) {
      await db.exec(readFileSync(new URL(fixture, FIXTURES), "utf8"));
    }
    await db.exec(`INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
      VALUES (pg_temp.id('vesna'), pg_temp.id('fak_a'), 'Vesna', 'Izmišljena'),
             (pg_temp.id('dora'), pg_temp.id('fak_a'), 'Dora', 'Izmišljena')`);
    await db.exec(`SET LOCAL ROLE ductus_evidence;
      INSERT INTO evidence.domain (id, institution_id, region)
      VALUES (gen_random_uuid(), pg_temp.id('fak_a'), 'eu-central-1');
      RESET ROLE;`);
    const dora = (await db.query<{ id: string }>("SELECT pg_temp.id('dora')::text AS id")).rows[0]!
      .id;
    const vesna = (await db.query<{ id: string }>("SELECT pg_temp.id('vesna')::text AS id"))
      .rows[0]!.id;

    // One connection: calls, the routes' fire-and-forget writes included, run one at a time.
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
    const main = { withActor };
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [
        ...createMentorshipConsultationRoutesFor(main),
        ...createThesisRoutesFor(main),
        ...createMentorNotesRoutesFor(main),
        ...createMentorshipFollowRoutesFor(main),
        ...createSelfNoteSealedRoutesFor(main),
      ],
    });
    try {
      const call = async (actor: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/${path}`, {
          method,
          headers: {
            cookie: `__Host-ductus_session=${actor.repeat(43)}`,
            ...(method === "GET"
              ? {}
              : {
                  origin: ORIGIN,
                  "sec-fetch-site": "same-origin",
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return {
          status: response.status,
          body: (await response.json()) as Record<string, unknown>,
        };
      };
      const statuses = async (actors: string[], method: string, path: string, body?: unknown) => {
        const got: string[] = [];
        for (const actor of actors)
          got.push(`${actor} ${(await call(actor, method, path, body)).status}`);
        return got;
      };

      // 1. The teacher opens the mentorship; only Dora sees it.
      const opening = {
        studentId: dora,
        workType: "master_thesis",
        topic: "Izmišljena tema o tlu",
      };
      const opened = await call("A", "POST", "mentorships", opening);
      expect(opened.status).toBe(201);
      const mentorshipId = opened.body.mentorshipId as string;
      const mine = (
        (await call("E", "GET", "student/mentorships")).body.mentorships as Record<
          string,
          unknown
        >[]
      ).find((m) => m.mentorshipId === mentorshipId);
      expect(mine).toMatchObject({ workType: "master_thesis", topic: "Izmišljena tema o tlu" });
      expect(JSON.stringify((await call("D", "GET", "student/mentorships")).body)).not.toContain(
        mentorshipId,
      );

      // Dora starts the work (the notice acknowledged as the RPC would write it).
      await db.query(
        `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
         VALUES ($1, 1, $2, pg_temp.id('fak_a'))`,
        [mine!.assignmentId, dora],
      );
      const started = await db.query<{ id: string }>(
        `SELECT pg_temp.ask('dora', format($$ SELECT document_id FROM app.open_student_work(%L, true) $$, $1::text)) AS id`,
        [mine!.assignmentId],
      );
      const work = `works/${encodeURIComponent(started.rows[0]!.id)}`;

      // 2. A slot: Dora asks, both sides read, nobody else does.
      const soon = new Date(Date.now() + 3 * 86_400_000).toISOString();
      const slot = await call("E", "POST", `${work}/consultation-slot-requests`, {
        startsAt: soon,
        topic: "Uzorkovanje",
      });
      expect(slot.status).toBe(201);
      for (const reader of ["A", "E"]) {
        expect((await call(reader, "GET", `${work}/consultation-slot-details`)).body.slots).toEqual(
          [slot.body],
        );
      }
      expect(await statuses(["B", "D", "I"], "GET", `${work}/consultation-slot-details`)).toEqual([
        "B 403",
        "D 403",
        "I 403",
      ]);

      // 3. Forms: the faculty publishes, the student submits, only the mentor accepts.
      const form = { code: "prijava-teme", title: "Prijava teme", workTypes: ["master_thesis"] };
      expect(
        await statuses(["A", "E", "I"], "POST", "institution/thesis-forms", {
          ...form,
          active: true,
        }),
      ).toEqual(["A 403", "E 403", "I 403"]);
      const published = await call("C", "POST", "institution/thesis-forms", {
        ...form,
        active: true,
      });
      expect(published).toMatchObject({ status: 201, body: { code: "prijava-teme", version: 1 } });
      const forms = `${work}/thesis-forms`;
      const before = await call("E", "GET", forms);
      expect(before.status).toBe(200);
      expect(JSON.stringify(before.body)).toContain('"state":"not_submitted"');
      expect(await statuses(["B", "D", "I"], "GET", forms)).toEqual(["B 404", "D 404", "I 404"]);
      expect(
        (await call("E", "PUT", `${forms}/prijava-teme`, { state: "submitted" })).body,
      ).toMatchObject({ state: "submitted", changedByPart: "student" });
      expect((await call("E", "PUT", `${forms}/prijava-teme`, { state: "accepted" })).status).toBe(
        403,
      );
      expect(
        await statuses(["B", "D", "I"], "PUT", `${forms}/prijava-teme`, { state: "accepted" }),
      ).toEqual(["B 404", "D 404", "I 404"]);
      expect(
        (await call("A", "PUT", `${forms}/prijava-teme`, { state: "accepted" })).body,
      ).toMatchObject({ state: "accepted", changedByPart: "mentor", changedBy: vesna });
      expect(
        (await call("E", "PUT", `${forms}/prijava-teme`, { state: "not_submitted" })).status,
      ).toBe(409);

      // 4. Consent: only the mentor gives or withdraws it; the student reads it.
      const consent = `${work}/mentor-consent`;
      expect(await statuses(["E", "D", "B", "I", "C"], "PUT", consent, { given: true })).toEqual([
        "E 403",
        "D 404",
        "B 404",
        "I 404",
        "C 403",
      ]);
      const given = await call("A", "PUT", consent, { given: true, comment: "Izmišljeno: može." });
      expect(given).toMatchObject({
        status: 200,
        body: { state: "given", changedBy: vesna, comment: "Izmišljeno: može." },
      });
      expect((await call("A", "PUT", consent, { given: true })).status).toBe(409);
      const seen = await call("E", "GET", consent);
      expect(seen).toMatchObject({ status: 200, body: { state: "given" } });
      expect(seen.body.history).toHaveLength(1);
      expect(await statuses(["B", "D", "I"], "GET", consent)).toEqual(["B 404", "D 404", "I 404"]);
      expect((await call("E", "PUT", consent, { given: false })).status).toBe(403);
      expect((await call("A", "PUT", consent, { given: false })).body).toMatchObject({
        state: "withdrawn",
      });

      // 5. The mentor's private note: hers alone.
      const notes = `mentorships/${mentorshipId}/notes`;
      expect((await call("A", "POST", notes, { body: "Izmišljena bilješka." })).status).toBe(201);
      const kept = await call("A", "GET", notes);
      expect(kept.body.notes).toMatchObject([{ body: "Izmišljena bilješka." }]);
      expect(await statuses(["E", "B", "I"], "GET", notes)).toEqual(["E 404", "B 404", "I 404"]);
      expect(await statuses(["E", "B"], "POST", notes, { body: "Tuđa bilješka." })).toEqual([
        "E 404",
        "B 404",
      ]);

      // 6. Dora's sealed note to self and reading place: hers alone.
      const key = {
        v: 1,
        keyId: KEY_ID,
        kdf: { alg: "PBKDF2-SHA-256", iterations: 600000 },
        phrase: wrap(),
        recovery: wrap(),
        ifVersion: null,
      };
      expect((await call("E", "PUT", "me/self-note-key", key)).status).toBe(200);
      const sealed = { v: 1, keyId: KEY_ID, iv: b64(12), ct: b64(1296) };
      const note = await call("E", "PUT", `${work}/sealed-self-note`, { sealed });
      expect(note).toMatchObject({ status: 200, body: { note: { sealed } } });
      const place = { nodeId: "1f0e2d3c-4b5a-4968-8776-655443322110", offset: 12 };
      expect((await call("E", "PUT", `${work}/reading-place`, { place })).status).toBe(200);
      expect((await call("E", "GET", `${work}/sealed-self-note`)).body).toMatchObject({
        note: { sealed },
        readingPlace: { place },
      });
      for (const stranger of ["A", "B", "D", "I"]) {
        const got = await call(stranger, "GET", `${work}/sealed-self-note`);
        expect(JSON.stringify(got.body)).not.toContain(sealed.ct);
      }

      // 7. The overview: the mentor sees Dora's work; nobody else does.
      const overview = await call("A", "GET", "teacher/mentorship-overview");
      expect(overview.status).toBe(200);
      expect(
        (overview.body.students as Record<string, unknown>[]).find(
          (s) => s.mentorshipId === mentorshipId,
        ),
      ).toMatchObject({ documentId: started.rows[0]!.id, workType: "master_thesis" });
      for (const other of ["B", "I"]) {
        const got = await call(other, "GET", "teacher/mentorship-overview");
        expect(JSON.stringify(got.body)).not.toContain(mentorshipId);
      }
      // Whoever mentors nobody, the student included, reads an empty list (the contract).
      expect(await call("E", "GET", "teacher/mentorship-overview")).toEqual({
        status: 200,
        body: { students: [] },
      });
      expect((await call("X", "GET", "teacher/mentorship-overview")).status).toBe(401);
    } finally {
      await server.close();
      await queue;
    }
  } finally {
    await db.close();
  }
});

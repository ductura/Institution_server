import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import type { WithActor } from "../../server/database/index.ts";
import { entriesThrough, practiceEntriesSha256 } from "../../server/domain/index.ts";
import {
  createDatabases,
  createLayers,
  createPracticeJournalRoutesFor,
  startServer,
} from "../../server/http/index.ts";

// SRV-V19-DNEVNIK-RUTE acceptance over the live database roles. Fixture tokens
// of institution.inc: A Vesna (teacher, mentors nobody here), B Marko (teacher,
// mentors Ana in ms1), D Ana (student of ms1), E Dora (student, another mentee),
// F Boris. Every person, organisation and text is invented.
const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const MS1 = "00000000-0000-4000-8000-0000000000d1";
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

it("keeps a practice journal between its student and its mentor and signs the same bytes the domain hashes", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    for (const fixture of ["institution.inc", "mentorship.inc"]) {
      await db.exec(readFileSync(new URL(fixture, FIXTURES), "utf8"));
    }
    await db.exec(`INSERT INTO identity.person_name (user_id, institution_id, given_name, family_name)
      SELECT id, institution_id, initcap(name), 'Izmišljenić' FROM person WHERE name IN ('marko', 'ana')`);

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
      routes: createPracticeJournalRoutesFor({ withActor }),
    });
    try {
      const call = async (actor: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(`http://127.0.0.1:${server.port}/api/v1/practice/${path}`, {
          method,
          headers: {
            ...(actor === "" ? {} : { cookie: `__Host-ductus_session=${actor.repeat(43)}` }),
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
      const period = {
        organisationName: "Izmišljena organizacija d.o.o.",
        startsOn: day(-30),
        endsOn: day(30),
      };

      // Only the mentor of the open mentorship opens a practice; every other is the same 404.
      expect((await call("", "POST", "placements", { mentorshipId: MS1, ...period })).status).toBe(
        401,
      );
      for (const stranger of ["A", "D", "E", "C", "F"]) {
        const refused = await call(stranger, "POST", "placements", {
          mentorshipId: MS1,
          ...period,
        });
        expect([stranger, refused.status, refused.body.code]).toEqual([stranger, 404, "not_found"]);
      }
      expect(
        (await call("B", "POST", "placements", { mentorshipId: MS1, ...period, startsOn: day(40) }))
          .status,
      ).toBe(422);
      expect(
        (
          await call("B", "POST", "placements", {
            mentorshipId: MS1,
            ...period,
            startsOn: "2026-02-30",
          })
        ).status,
      ).toBe(422);
      const opened = await call("B", "POST", "placements", { mentorshipId: MS1, ...period });
      expect(opened.status).toBe(201);
      const id = opened.body.placementId as string;
      const base = `placements/${id}`;

      // The student writes, nobody else: the mentor, the other teacher and a stranger get 404.
      const first = await call("D", "POST", `${base}/entries`, {
        date: day(-5),
        hours: 7.5,
        text: "Izmišljeni zapis: upoznavanje s timom.",
      });
      const second = await call("D", "POST", `${base}/entries`, {
        date: day(-4),
        hours: 8,
        text: "Izmišljeni zapis: rad na izvješću.",
      });
      expect([first.status, second.status]).toEqual([201, 201]);
      for (const other of ["B", "A", "E", "F"]) {
        const refused = await call(other, "POST", `${base}/entries`, {
          date: day(-3),
          hours: 2,
          text: "Tuđi unos.",
        });
        expect([other, refused.status]).toEqual([other, 404]);
      }
      expect(
        (
          await call("D", "POST", `${base}/entries`, {
            date: day(-40),
            hours: 2,
            text: "Prije razdoblja.",
          })
        ).body.code,
      ).toBe("placement_closed");
      expect(
        (
          await call("D", "POST", `${base}/entries`, {
            date: day(40),
            hours: 2,
            text: "Poslije razdoblja.",
          })
        ).body.code,
      ).toBe("placement_closed");
      expect(
        (
          await call("D", "POST", `${base}/entries`, {
            date: day(10),
            hours: 2,
            text: "U budućnosti.",
          })
        ).status,
      ).toBe(422);
      expect(
        (
          await call("D", "POST", `${base}/entries`, {
            date: day(-3),
            hours: 2,
            text: "x",
            correctsEntryId: MS1,
          })
        ).status,
      ).toBe(422);
      expect(
        (await call("D", "POST", `${base}/entries`, { date: day(-3), hours: 2.25, text: "x" }))
          .status,
      ).toBe(422);
      expect(
        (await call("D", "POST", `${base}/entries`, { date: day(-3), hours: 2, text: "č" })).status,
      ).toBe(422);

      // Student and mentor read the same journal; everyone else, a made-up id and a malformed id read 404.
      const asStudent = await call("D", "GET", `${base}/entries`);
      const asMentor = await call("B", "GET", `${base}/entries`);
      expect(asStudent.status).toBe(200);
      expect(asMentor.body).toEqual(asStudent.body);
      const entries = asStudent.body.entries as {
        entryId: string;
        date: string;
        hours: number;
        text: string;
        correctsEntryId: string | null;
      }[];
      expect(entries.map((e) => [e.date, e.hours])).toEqual([
        [day(-5), 7.5],
        [day(-4), 8],
      ]);
      for (const other of ["A", "E", "F", "C"])
        expect((await call(other, "GET", `${base}/entries`)).status).toBe(404);
      for (const bad of ["00000000-0000-4000-8000-00000000beef", "not-a-uuid"]) {
        expect((await call("D", "GET", `placements/${bad}/entries`)).status).toBe(404);
        expect(
          (await call("B", "POST", `placements/${bad}/signoffs`, { throughDate: day(-4) })).status,
        ).toBe(404);
      }

      // Lists: the student's own, the mentor's mentored, nobody else's.
      for (const reader of ["D", "B"]) {
        expect((await call(reader, "GET", "placements")).body).toEqual({
          placements: [
            { placementId: id, mentorshipId: MS1, ...period, entryCount: 2, signedThrough: null },
          ],
        });
      }
      for (const other of ["A", "E", "C", "F"])
        expect((await call(other, "GET", "placements")).body).toEqual({ placements: [] });

      // Signing: only the mentor; the digest is the one the domain computes for the same entries.
      expect((await call("D", "POST", `${base}/signoffs`, { throughDate: day(-4) })).status).toBe(
        404,
      );
      expect(
        (await call("B", "POST", `${base}/signoffs`, { throughDate: day(-6) })).body.code,
      ).toBe("nothing_to_sign");
      expect((await call("B", "POST", `${base}/signoffs`, { throughDate: day(5) })).status).toBe(
        422,
      );
      const signed = await call("B", "POST", `${base}/signoffs`, {
        throughDate: day(-4),
        comment: "Izmišljeni komentar mentora.",
      });
      expect(signed.status).toBe(201);
      expect(signed.body).toMatchObject({
        entryCount: 2,
        entriesSha256: practiceEntriesSha256(entriesThrough(entries, day(-4))),
      });
      expect(
        (await call("B", "POST", `${base}/signoffs`, { throughDate: day(-4) })).body.code,
      ).toBe("nothing_to_sign");

      // A correction is a new entry: the old one stays, and only a new signoff covers it.
      const correction = await call("D", "POST", `${base}/entries`, {
        date: day(-4),
        hours: 6,
        text: "Izmišljeni ispravak.",
        correctsEntryId: second.body.entryId,
      });
      expect(correction.status).toBe(201);
      const after = (await call("D", "GET", `${base}/entries`)).body.entries as typeof entries;
      expect(after).toHaveLength(3);
      expect(after.find((e) => e.entryId === correction.body.entryId)?.correctsEntryId).toBe(
        second.body.entryId,
      );
      const resigned = await call("B", "POST", `${base}/signoffs`, { throughDate: day(-4) });
      expect(resigned.body.entriesSha256).toBe(
        practiceEntriesSha256(entriesThrough(after, day(-4))),
      );
      expect(resigned.body.entriesSha256).not.toBe(signed.body.entriesSha256);

      // Both sides read the same signoffs, newest first, with the mentor's name and comment; strangers read 404.
      const signoffs = await call("D", "GET", `${base}/signoffs`);
      expect(signoffs.body).toEqual((await call("B", "GET", `${base}/signoffs`)).body);
      const listed = signoffs.body.signoffs as {
        signoffId: string;
        comment: string | null;
        entryCount: number;
        mentor: { givenName: string };
      }[];
      expect(listed.map((s) => [s.signoffId, s.comment, s.entryCount])).toEqual([
        [resigned.body.signoffId, null, 3],
        [signed.body.signoffId, "Izmišljeni komentar mentora.", 2],
      ]);
      expect(listed[0]!.mentor.givenName).toBe("Marko");
      for (const other of ["A", "E", "F"])
        expect((await call(other, "GET", `${base}/signoffs`)).status).toBe(404);
      expect(
        ((await call("B", "GET", "placements")).body.placements as { signedThrough: string }[])[0]!
          .signedThrough,
      ).toBe(day(-4));
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
}, 120_000);

import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer } from "../index.ts";

import { createMentorWorkingStyleRoutesFor } from "./index.ts";

// F4-MEN-R09-SRV over the live database roles. Tokens: B Marko (mentor of Ana),
// D Ana, E Dora (student with no mentorship of Marko), A Vesna (teacher).
const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";

it("the mentor writes the own text and only the mentor's student reads it", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
    await db.exec(readFileSync(new URL("mentorship.inc", FIXTURES), "utf8"));
    const marko = (await db.query<{ id: string }>("SELECT pg_temp.id('marko')::text AS id"))
      .rows[0]!.id;
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
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createMentorWorkingStyleRoutesFor({ withActor }),
    });
    try {
      const base = `http://127.0.0.1:${server.port}/api/v1`;
      const cookie = (actor: string) => `__Host-ductus_session=${actor.repeat(43)}`;
      const get = async (id: string, actor: string) => {
        const r = await fetch(`${base}/student/mentors/${id}/working-style`, {
          headers: { cookie: cookie(actor) },
        });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };
      const put = async (text: unknown, actor: string) => {
        const r = await fetch(`${base}/teacher/mentor-working-style`, {
          method: "PUT",
          headers: {
            cookie: cookie(actor),
            origin: ORIGIN,
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
          },
          body: JSON.stringify({ text }),
        });
        return { status: r.status, body: (await r.json()) as Record<string, unknown> };
      };

      expect((await get(marko, "D")).body).toEqual({ text: null, updatedAt: null });
      expect((await put("Izmišljeni način rada.", "B")).status).toBe(200);
      expect((await put("Izmišljeni način rada.", "D")).status).toBe(403);
      expect((await put("   ", "B")).status).toBe(422);
      expect((await put("a".repeat(1001), "B")).status).toBe(422);
      expect((await put("x".repeat(1000), "B")).status).toBe(200);
      expect((await get(marko, "D")).body).toMatchObject({ text: "x".repeat(1000) });
      // Not the mentor's student, a teacher, an unknown mentor, a bad id: one 404.
      for (const [id, actor] of [
        [marko, "E"],
        [marko, "A"],
        [marko, "B"],
        ["00000000-0000-4000-8000-00000000ffff", "D"],
        ["nije-uuid", "D"],
      ] as const) {
        expect((await get(id, actor)).status).toBe(404);
      }
      const anon = await fetch(`${base}/student/mentors/${marko}/working-style`);
      expect(anon.status).toBe(401);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
}, 60_000);

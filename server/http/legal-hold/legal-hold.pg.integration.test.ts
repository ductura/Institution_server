// SRV-1306 on a real database: the legal-hold routes over SRV-1305's RPCs.
// Iva and Boris are administrators of fak-a, Lea of fak-b (fixtures/institution.inc;
// Boris is appointed here), Vesna a teacher. The administrator who places a hold
// cannot release it (403), the other one does (200), a hold released is 409, and a
// hold of another institution is 404. All persons, cases and reasons are invented.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";

import { createDatabases, createLayers, startServer } from "../index.ts";
import { createLegalHoldRoutesFor } from "./index.ts";

const institution = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const ORIGIN = "https://ductura.example.invalid";
const BASE = "/api/v1/institution/legal-holds";

it("places a hold, refuses its own release, releases it as another administrator", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
    await db.exec(
      "SELECT institution.appoint_institution_admin(pg_temp.id('boris'), 'Zahtjev boris/2026')",
    );
    const { rows } = await db.query<{ name: string; val: string }>("SELECT name, val FROM ref");
    const ids = new Map(rows.map(({ name, val }) => [name, val]));
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(text: string, values?: readonly unknown[]) {
            const { rows: found } = await db.query<Row>(text, [...(values ?? [])]);
            return { rows: found, rowCount: found.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      layers: createLayers({ expectedOrigin: ORIGIN }),
      databases: createDatabases(),
      routes: createLegalHoldRoutesFor({ withActor }),
    });
    try {
      const IVA = "C";
      const BORIS = "F";
      const VESNA = "A";
      const LEA = "H";
      const call = async (actor: string, method: string, path: string, body?: unknown) => {
        const got = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method,
          headers: {
            cookie: `__Host-ductus_session=${actor.repeat(43)}`,
            ...(method === "POST"
              ? {
                  origin: ORIGIN,
                  "sec-fetch-site": "same-origin",
                  "content-type": "application/json",
                }
              : {}),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        return { status: got.status, body: (await got.json()) as Record<string, unknown> };
      };
      const placed = {
        subjectType: "student",
        subjectId: ids.get("ana")!,
        caseReference: "IZMISLJENI-SLUCAJ-2026-01",
      };

      // Place as Iva.
      const made = await call(IVA, "POST", BASE, placed);
      expect(made.status).toBe(201);
      const holdId = made.body.holdId as string;
      expect(holdId).toMatch(/^[0-9a-f-]{36}$/u);

      // Not an administrator, or no session role: 403. Another institution's subject: 404. Bad reference: 422.
      expect((await call(VESNA, "POST", BASE, placed)).status).toBe(403);
      expect((await call(VESNA, "GET", BASE)).status).toBe(403);
      expect((await call(LEA, "POST", BASE, placed)).status).toBe(404);
      expect(
        (await call(IVA, "POST", BASE, { ...placed, subjectType: "work", subjectId: "" })).status,
      ).toBe(422);
      expect((await call(IVA, "POST", BASE, { ...placed, caseReference: " " })).status).toBe(422);

      // The list shows it as standing.
      const listed = await call(BORIS, "GET", BASE);
      expect(listed.status).toBe(200);
      expect(listed.body.holds).toEqual([
        expect.objectContaining({
          holdId,
          subjectType: "student",
          subjectId: ids.get("ana"),
          caseReference: placed.caseReference,
          placedBy: ids.get("iva"),
          releasedBy: null,
          releasedAt: null,
        }),
      ]);

      // The same administrator cannot release it.
      const own = `${BASE}/${holdId}/release`;
      const reason = { reason: "Izmišljeni razlog: slučaj je zaključen." };
      expect((await call(IVA, "POST", own, reason)).status).toBe(403);
      expect((await call(VESNA, "POST", own, reason)).status).toBe(403);
      // Another institution's administrator does not see it at all.
      expect((await call(LEA, "POST", own, reason)).status).toBe(404);
      expect((await call(BORIS, "POST", own, { reason: "  " })).status).toBe(422);
      expect((await call(BORIS, "POST", `${BASE}/nije-uuid/release`, reason)).status).toBe(404);

      // Boris releases it.
      const released = await call(BORIS, "POST", own, reason);
      expect(released.status).toBe(200);
      expect(released.body).toEqual({ holdId, releasedAt: expect.any(String) });
      expect((await call(BORIS, "POST", own, reason)).status).toBe(409);

      const after = await call(IVA, "GET", BASE);
      expect(after.body.holds).toEqual([
        expect.objectContaining({
          holdId,
          releasedBy: ids.get("boris"),
          releasedAt: (released.body as { releasedAt: string }).releasedAt,
        }),
      ]);
      expect((await call(LEA, "GET", BASE)).body).toEqual({ holds: [] });
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

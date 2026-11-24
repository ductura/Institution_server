// SRV-ADMIN-1 on a real database: the problem reports routed by kind, their
// state and the administrator's action log, over the RPCs of migrations
// 20261215100000 and 20261215100100. Persons of fixtures/institution.inc: Iva
// administrator of fak-a, Vesna teacher of K1, Marko teacher of K2, Ana a
// student of K1, Boris appointed network engineer here, Lea administrator of
// fak-b. All texts are invented.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";

import {
  createAdminActionLogRouteFor,
  createDatabases,
  createLayers,
  createProblemReportInboxRoutesFor,
  createProblemReportsRouteFor,
  startServer,
} from "../index.ts";

const institution = readFileSync(
  new URL("../../../db/main/tests/fixtures/institution.inc", import.meta.url),
  "utf8",
);
const ORIGIN = "https://ductura.example.invalid";
// Session tokens of the fixture: one letter per person, in the order of their ids.
const VESNA = "A";
const MARKO = "B";
const IVA = "C";
const ANA = "D";
const BORIS = "F";
const LEA = "H";

it("routes each report to its readers, keeps the state and logs the administrator actions", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(institution);
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
      routes: [
        createProblemReportsRouteFor({ withActor }),
        ...createProblemReportInboxRoutesFor({ withActor }),
        createAdminActionLogRouteFor({ withActor }),
      ],
    });
    try {
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
      const report = (category: string, description: string, courseId?: string) => ({
        appVersion: "1.4.0",
        category,
        description,
        ...(courseId === undefined ? {} : { courseId }),
      });
      const reports = (body: Record<string, unknown>) =>
        (body.reports as { reference: string; category: string; routedTo: string }[]).map(
          (r) => `${r.category}:${r.routedTo}`,
        );

      // Boris becomes the network engineer of fak-a.
      await withActor(IVA.repeat(43), (tx) =>
        tx.query("SELECT identity.appoint_network_engineer($1::uuid)", [ids.get("boris")]),
      );

      // Ana reports: technical, account, and one about K1 that names it.
      const k1 = ids.get("k1")!;
      for (const sent of [
        report("technical", "Izmišljeni opis: ne sprema se."),
        report("account", "Izmišljeni opis: ne vidim ulogu."),
        report("course", "Izmišljeni opis: rok zadatka.", k1),
      ]) {
        expect((await call(ANA, "POST", "/api/v1/problem-reports", sent)).status).toBe(201);
      }
      // A course of another student, or a course on another kind, is 422.
      const k2 = ids.get("k2")!;
      expect(
        (await call(ANA, "POST", "/api/v1/problem-reports", report("course", "Izmišljeno.", k2)))
          .status,
      ).toBe(422);
      expect(
        (await call(ANA, "POST", "/api/v1/problem-reports", report("technical", "Izmišljeno.", k1)))
          .status,
      ).toBe(422);

      // Who reads what.
      const engineer = await call(BORIS, "GET", "/api/v1/problem-reports");
      expect(engineer.status).toBe(200);
      expect(reports(engineer.body)).toEqual(["technical:network_engineer"]);
      expect(reports((await call(IVA, "GET", "/api/v1/problem-reports")).body)).toEqual([
        "account:institution_admin",
      ]);
      const teacher = await call(VESNA, "GET", "/api/v1/problem-reports");
      expect(reports(teacher.body)).toEqual(["course:course_teacher"]);
      expect(teacher.body.truncated).toBe(false);
      const [about] = teacher.body.reports as Record<string, unknown>[];
      expect(about).toMatchObject({
        courseId: k1,
        description: "Izmišljeni opis: rok zadatka.",
        status: "received",
        statusChangedAt: null,
        statusChangedByRole: null,
        statusChangedByMe: false,
      });
      expect(JSON.stringify(teacher.body)).not.toContain(ids.get("ana"));
      expect(reports((await call(MARKO, "GET", "/api/v1/problem-reports")).body)).toEqual([]);
      expect((await call(LEA, "GET", "/api/v1/problem-reports")).body.reports).toEqual([]);
      expect((await call(ANA, "GET", "/api/v1/problem-reports")).status).toBe(403);
      expect((await call(VESNA, "GET", "/api/v1/problem-reports?kategorija=course")).status).toBe(
        422,
      );

      // The state: the teacher resolves the report about K1; nobody else may.
      const reference = about!.reference as string;
      const path = `/api/v1/problem-reports/${reference}/status`;
      expect((await call(IVA, "POST", path, { status: "resolved" })).status).toBe(404);
      expect((await call(MARKO, "POST", path, { status: "resolved" })).status).toBe(404);
      expect((await call(ANA, "POST", path, { status: "resolved" })).status).toBe(403);
      expect((await call(VESNA, "POST", path, { status: "closed" })).status).toBe(422);
      expect(
        (await call(VESNA, "POST", "/api/v1/problem-reports/pr-1/status", { status: "resolved" }))
          .status,
      ).toBe(422);
      const resolved = await call(VESNA, "POST", path, { status: "resolved" });
      expect(resolved).toEqual({
        status: 200,
        body: { reference, status: "resolved", statusChangedAt: expect.any(String) },
      });
      const again = await call(VESNA, "POST", path, { status: "resolved" });
      expect(again.body.statusChangedAt).toBe(resolved.body.statusChangedAt);
      const [now] = (await call(VESNA, "GET", "/api/v1/problem-reports")).body.reports as Record<
        string,
        unknown
      >[];
      expect(now).toMatchObject({
        status: "resolved",
        statusChangedByRole: "course_teacher",
        statusChangedByMe: true,
      });

      // The action log: only the administrator, and no person in it.
      const log = await call(IVA, "GET", "/api/v1/institution/admin-actions");
      expect(log.status).toBe(200);
      expect(log.body.entries).toContainEqual({
        at: expect.any(String),
        actorRole: "institution_admin",
        action: "role_confirmed",
        subjectRole: "network_engineer",
        outcome: "completed",
        rosterImport: null,
      });
      expect(JSON.stringify(log.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
      expect((await call(VESNA, "GET", "/api/v1/institution/admin-actions")).status).toBe(403);
      expect((await call(BORIS, "GET", "/api/v1/institution/admin-actions")).status).toBe(403);
      const other = await call(LEA, "GET", "/api/v1/institution/admin-actions");
      expect(other.body.entries).not.toContainEqual(
        expect.objectContaining({ subjectRole: "network_engineer" }),
      );
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

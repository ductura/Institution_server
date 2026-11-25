import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import { createQualitativeCodingStore, type WithActor } from "../database/index.ts";

import { createDatabases, createLayers, startServer } from "./index.ts";
import { createQualitativeMaterialsRoutesFor } from "./qualitative-materials.ts";

// SRV-V18-KODIRANJE-GRADIVO: the student's own material for qualitative coding,
// through the HTTP routes and the live database roles. Every person and text is
// invented (db/main/tests/fixtures/institution.inc: Vesna (A) teaches K1, Ana (D)
// and Dora (E) are students in K1). Another person's material is the same 404 as
// an unknown or a malformed id; the teacher reads and deletes nothing either.
const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const VESNA = "A".repeat(43);
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const PATH = "/api/v1/student/qual/materials";

it("keeps a material for its owner only and refuses everyone else with 404", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));

    // One connection: the calls, the activity touch included, go one after another.
    let queue: Promise<unknown> = Promise.resolve();
    const withActor: WithActor = (token, run) => {
      const next = queue.then(async () => {
        await db.query("SELECT set_config('app.session_token', $1, true)", [token ?? ""]);
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
      });
      queue = next.catch(() => undefined);
      return next;
    };
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createQualitativeMaterialsRoutesFor({ withActor }),
    });
    try {
      const call = (method: string, path: string, token: string, body?: unknown) =>
        fetch(`http://127.0.0.1:${server.port}${path}`, {
          method,
          headers: {
            origin: ORIGIN,
            cookie: `__Host-ductus_session=${token}`,
            ...(body === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      const keep = (token: string, body: unknown) => call("POST", PATH, token, body);
      const mine = {
        title: "Intervju A",
        kind: "interview",
        text: "Prvi red.\r\n\r\nTreći red: šuma.",
      };

      // (1) Ana keeps a material; the pasted line breaks are stored as \n.
      const kept = await keep(ANA, mine);
      expect(kept.status).toBe(201);
      const material = (await kept.json()) as { id: string; text: string };
      expect(material).toMatchObject({
        title: "Intervju A",
        kind: "interview",
        text: "Prvi red.\n\nTreći red: šuma.",
        segmentCount: 0,
        locked: false,
      });
      const read = await call("GET", `${PATH}/${material.id}`, ANA);
      expect(read.status).toBe(200);
      expect(await read.json()).toEqual(material);
      const listed = await call("GET", PATH, ANA);
      expect(await listed.json()).toMatchObject({
        materials: [{ id: material.id, charCount: [...material.text].length, locked: false }],
      });

      // (2) Another student, the teacher and a malformed id: the same 404; the
      // list of another person is empty.
      for (const token of [DORA, VESNA]) {
        expect((await call("GET", `${PATH}/${material.id}`, token)).status).toBe(404);
        expect((await call("DELETE", `${PATH}/${material.id}`, token)).status).toBe(404);
        expect(await (await call("GET", PATH, token)).json()).toEqual({ materials: [] });
      }
      expect((await call("GET", `${PATH}/nije-uuid`, ANA)).status).toBe(404);
      expect((await call("DELETE", `${PATH}/${material.id.toUpperCase()}`, ANA)).status).toBe(404);
      expect((await call("GET", `${PATH}/${crypto.randomUUID()}`, ANA)).status).toBe(404);

      // (3) Input outside the rules: 422, and nothing is kept.
      for (const bad of [
        { ...mine, title: " Naslov" },
        { ...mine, kind: "zvuk" },
        { ...mine, text: "" },
        { ...mine, text: "   \n " },
        { ...mine, text: "Tekst\u0001" },
        { ...mine, text: "a".repeat(100_001) },
        { ...mine, audio: "x" },
      ]) {
        expect((await keep(ANA, bad)).status, JSON.stringify(bad).slice(0, 60)).toBe(422);
      }
      expect((await keep(ANA, { ...mine, text: "a".repeat(100_000) })).status).toBe(201);

      // (4) A material with a marked passage is locked and goes with its passages.
      const coding = createQualitativeCodingStore(withActor);
      const codeId = await coding.createCode(ANA, "Kod A");
      await coding.createSegment(ANA, material.id, codeId, {
        paragraph: 0,
        start: 0,
        end: 4,
        quote: "Prvi",
      });
      const locked = await call("GET", `${PATH}/${material.id}`, ANA);
      expect(await locked.json()).toMatchObject({ segmentCount: 1, locked: true });

      // (5) The owner deletes it; it is gone and the passages with it.
      const removed = await call("DELETE", `${PATH}/${material.id}`, ANA);
      expect(removed.status).toBe(204);
      expect((await call("GET", `${PATH}/${material.id}`, ANA)).status).toBe(404);
      const left = await db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM institution.qual_segment WHERE material_id = $1",
        [material.id],
      );
      expect(left.rows[0]!.n).toBe(0);

      // (6) No session: 401.
      const anonymous = await fetch(`http://127.0.0.1:${server.port}${PATH}`);
      expect(anonymous.status).toBe(401);
    } finally {
      await server.close();
      await queue;
    }
  } finally {
    await db.close();
  }
});

import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import { createQualitativeCodingStore, type WithActor } from "../database/index.ts";

import { createDatabases, createLayers, startServer } from "./index.ts";
import { createQualitativeSegmentsRoutesFor } from "./qualitative-segments.ts";

// SRV-V18-KODIRANJE-OZNAKE: the passages a student marks in their own material
// and the export of the coding, through the HTTP routes and the live database
// roles. Every person and text is invented (db/main/tests/fixtures/institution.inc:
// Vesna (A) teaches K1, Ana (D) and Dora (E) are students in K1). Another
// person's material, code and passage are the same 404 as an unknown or a
// malformed id; the teacher reads and deletes nothing either. The export lists
// the codebook in its own order, never by use (V18-8).
const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const VESNA = "A".repeat(43);
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const MATERIALS = "/api/v1/student/qual/materials";
const EXPORT = "/api/v1/student/qual/export";

type Wire = { id: string; codeId: string; paragraph: number; start: number; end: number };
type Export = {
  schema: string;
  codebook: { code: string; name: string }[];
  segments: { material: string; code: string; paragraph: number; start: number }[];
  counts: { code: string; material: string; n: number }[];
};

it("marks passages for their owner only and exports the coding in the order of the codebook", async () => {
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
      routes: createQualitativeSegmentsRoutesFor({ withActor }),
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
      const store = createQualitativeCodingStore(withActor);
      const text = "Prvi red: mentor.\nDrugi red: rok i mentor.";
      const material = await store.createMaterial(ANA, "Intervju A", "interview", text);
      const second = await store.createMaterial(ANA, "Bilješka A", "note", "Mentor je rekao da.");
      const mentor = await store.createCode(ANA, "Mentor");
      const deadline = await store.createCode(ANA, "Rok");
      const segmentsOf = (id: string) => `${MATERIALS}/${id}/segments`;
      const mark = (token: string, id: string, codeId: string, anchor: object, memo?: string) =>
        call("POST", segmentsOf(id), token, { codeId, anchor, ...(memo ? { memo } : {}) });

      // (1) Ana marks passages; the answer is the passage, the memo is null when there is none.
      const first = await mark(
        ANA,
        material,
        mentor,
        { paragraph: 1, start: 17, end: 23, quote: "mentor" },
        "Izmišljena napomena.",
      );
      expect(first.status).toBe(201);
      const firstSegment = (await first.json()) as Wire & { memo: string; quote: string };
      expect(firstSegment).toMatchObject({
        codeId: mentor,
        paragraph: 1,
        start: 17,
        end: 23,
        quote: "mentor",
        memo: "Izmišljena napomena.",
      });
      expect(
        (await mark(ANA, material, mentor, { paragraph: 0, start: 10, end: 16, quote: "mentor" }))
          .status,
      ).toBe(201);
      expect(
        (await mark(ANA, material, deadline, { paragraph: 1, start: 11, end: 14, quote: "rok" }))
          .status,
      ).toBe(201);
      expect(
        (await mark(ANA, second, deadline, { paragraph: 0, start: 0, end: 6, quote: "Mentor" }))
          .status,
      ).toBe(201);
      // In characters, not UTF-16 units: the quote of a letter with a caron.
      const accented = await store.createMaterial(ANA, "Bilješka B", "note", "žaba šuti");
      expect(
        (await mark(ANA, accented, mentor, { paragraph: 0, start: 5, end: 9, quote: "šuti" }))
          .status,
      ).toBe(201);

      // (2) The list is in the order of the text, with the memo null where there is none.
      const listed = await call("GET", segmentsOf(material), ANA);
      expect(listed.status).toBe(200);
      const list = (await listed.json()) as { segments: (Wire & { memo: string | null })[] };
      expect(list.segments.map((s) => [s.paragraph, s.start])).toEqual([
        [0, 10],
        [1, 11],
        [1, 17],
      ]);
      expect(list.segments[0]!.memo).toBeNull();
      const locked = await store.readMaterial(ANA, material);
      expect(locked).toMatchObject({ segmentCount: 3, locked: true });

      // (3) Input outside the rules: 422, and nothing is marked.
      const before = (await (await call("GET", segmentsOf(material), ANA)).json()) as {
        segments: unknown[];
      };
      for (const anchor of [
        { paragraph: 0, start: 10, end: 16, quote: "Mentor" },
        { paragraph: 0, start: 0, end: 3, quote: "Pr" },
        { paragraph: 9, start: 0, end: 6, quote: "Prvi r" },
        { paragraph: 0, start: 5, end: 5, quote: "r" },
        { paragraph: 0, start: 0, end: 501, quote: "x".repeat(501) },
        { paragraph: 0, start: 4, end: 5, quote: " " },
        { paragraph: 0, start: 0, end: 6 },
        { paragraph: -1, start: 0, end: 6, quote: "Prvi r" },
      ]) {
        const refused = await mark(ANA, material, mentor, anchor);
        expect(refused.status, JSON.stringify(anchor)).toBe(422);
      }
      const okAnchor = { paragraph: 0, start: 0, end: 4, quote: "Prvi" };
      expect((await mark(ANA, material, mentor, okAnchor, "")).status).toBe(201);
      expect(
        (await call("POST", segmentsOf(material), ANA, { codeId: mentor, anchor: okAnchor, x: 1 }))
          .status,
      ).toBe(422);
      expect((await call("POST", segmentsOf(material), ANA, { anchor: okAnchor })).status).toBe(
        422,
      );
      expect((await mark(ANA, material, mentor, okAnchor, "m".repeat(1001))).status).toBe(422);
      expect((await mark(ANA, material, mentor, okAnchor)).status).toBe(409);
      const after = (await (await call("GET", segmentsOf(material), ANA)).json()) as {
        segments: unknown[];
      };
      expect(after.segments).toHaveLength(before.segments.length + 1);

      // (4) Another student, the teacher, an unknown and a malformed id: the same 404.
      const stranger = await store.createCode(DORA, "Dorin kod");
      for (const token of [DORA, VESNA]) {
        expect((await call("GET", segmentsOf(material), token)).status).toBe(404);
        expect((await mark(token, material, mentor, okAnchor)).status).toBe(404);
        expect(
          (await call("DELETE", `/api/v1/student/qual/segments/${firstSegment.id}`, token)).status,
        ).toBe(404);
        expect((await call("GET", `${EXPORT}?materialId=${material}`, token)).status).toBe(404);
      }
      // Ana's own material with Dora's code, and Dora's material with Ana's code, are 404 too.
      expect((await mark(ANA, material, stranger, okAnchor)).status).toBe(404);
      expect((await mark(ANA, material, crypto.randomUUID(), okAnchor)).status).toBe(404);
      expect((await mark(ANA, crypto.randomUUID(), mentor, okAnchor)).status).toBe(404);
      expect((await call("GET", segmentsOf("nije-uuid"), ANA)).status).toBe(404);
      expect((await mark(ANA, "nije-uuid", mentor, okAnchor)).status).toBe(404);
      expect((await call("DELETE", "/api/v1/student/qual/segments/nije-uuid", ANA)).status).toBe(
        404,
      );
      expect(
        (await call("DELETE", `/api/v1/student/qual/segments/${crypto.randomUUID()}`, ANA)).status,
      ).toBe(404);
      expect((await call("GET", `${EXPORT}?materialId=nije-uuid`, ANA)).status).toBe(404);
      expect((await call("GET", `${EXPORT}?materialId=${crypto.randomUUID()}`, ANA)).status).toBe(
        404,
      );
      expect((await call("GET", `${EXPORT}?other=1`, ANA)).status).toBe(422);

      // (5) The export: the codebook in its own order, then the materials, then the text;
      // the counts are never by number. Mentor has four passages, Rok two.
      const exported = await call("GET", EXPORT, ANA);
      expect(exported.status).toBe(200);
      const all = (await exported.json()) as Export;
      expect(all.schema).toBe("qualitative-export-v1");
      expect(all.codebook.map((c) => c.name)).toEqual(["Mentor", "Rok"]);
      expect(
        all.segments.map((s) => [s.code === mentor ? "M" : "R", s.paragraph, s.start]),
      ).toEqual([
        ["M", 0, 0],
        ["M", 0, 10],
        ["M", 1, 17],
        ["M", 0, 5],
        ["R", 1, 11],
        ["R", 0, 0],
      ]);
      expect(all.counts.map((c) => [c.code === mentor ? "M" : "R", c.n])).toEqual([
        ["M", 3],
        ["M", 1],
        ["R", 1],
        ["R", 1],
      ]);
      // Moving the code that is used least first moves it first: the order is the owner's.
      await store.moveCode(ANA, deadline, 1);
      const moved = (await (await call("GET", EXPORT, ANA)).json()) as Export;
      expect(moved.codebook.map((c) => c.name)).toEqual(["Rok", "Mentor"]);
      expect(moved.segments[0]!.code).toBe(deadline);
      // One material only.
      const one = (await (
        await call("GET", `${EXPORT}?materialId=${second}`, ANA)
      ).json()) as Export;
      expect(one.segments).toHaveLength(1);
      expect(one.counts).toEqual([{ code: deadline, material: second, n: 1 }]);
      // The same coding gives the same bytes.
      expect(await (await call("GET", EXPORT, ANA)).text()).toBe(
        await (await call("GET", EXPORT, ANA)).text(),
      );
      // Another person's export is their own (empty of Ana's), never Ana's.
      for (const token of [DORA, VESNA]) {
        const theirs = (await (await call("GET", EXPORT, token)).json()) as Export;
        expect(theirs.segments).toEqual([]);
        expect(theirs.counts).toEqual([]);
        expect(theirs.codebook.map((c) => c.code)).not.toContain(mentor);
      }

      // (6) The owner removes a passage; it is gone, the material is still locked while one is left.
      const removed = await call("DELETE", `/api/v1/student/qual/segments/${firstSegment.id}`, ANA);
      expect(removed.status).toBe(204);
      expect(
        (await call("DELETE", `/api/v1/student/qual/segments/${firstSegment.id}`, ANA)).status,
      ).toBe(404);
      const rest = (await (await call("GET", segmentsOf(material), ANA)).json()) as {
        segments: Wire[];
      };
      expect(rest.segments.map((s) => s.id)).not.toContain(firstSegment.id);

      // (7) No session: 401.
      for (const [method, path] of [
        ["GET", segmentsOf(material)],
        ["POST", segmentsOf(material)],
        ["DELETE", `/api/v1/student/qual/segments/${firstSegment.id}`],
        ["GET", EXPORT],
      ] as const) {
        const anonymous = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method,
          headers: { origin: ORIGIN, "content-type": "application/json" },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        expect(anonymous.status, `${method} ${path}`).toBe(401);
      }
    } finally {
      await server.close();
      await queue;
    }
  } finally {
    await db.close();
  }
});

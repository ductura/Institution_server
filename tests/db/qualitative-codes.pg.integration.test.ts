import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import { createTestDatabase } from "../../test-support/database/index.ts";
import { createQualitativeCodingStore, type WithActor } from "../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createQualitativeCodesRoutesFor,
  startServer,
} from "../../server/http/index.ts";

// SRV-V18-KODIRANJE-SIFRARNIK acceptance over the live database roles. Fixture
// tokens of institution.inc: B Marko (teacher), D Ana and E Dora (students). The
// codebook is the caller's own: nobody else reads, renames, moves or deletes a
// code of it, whatever their role. Every person and text is invented.
const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const ORIGIN = "https://ductura.example.invalid";
const MISSING = "00000000-0000-4000-8000-0000000000ff";

it("keeps a codebook in the owner's order and shows it to nobody else", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
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
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: createQualitativeCodesRoutesFor({ withActor }),
    });
    try {
      const call = async (actor: string, method: string, path: string, body?: unknown) => {
        const response = await fetch(
          `http://127.0.0.1:${server.port}/api/v1/student/qual/codes${path}`,
          {
            method,
            headers: {
              ...(actor === "" ? {} : { cookie: `__Host-ductus_session=${actor.repeat(43)}` }),
              ...(method === "GET"
                ? {}
                : {
                    origin: ORIGIN,
                    "sec-fetch-site": "same-origin",
                    ...(body === undefined ? {} : { "content-type": "application/json" }),
                  }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          },
        );
        const text = await response.text();
        return {
          status: response.status,
          body: (text === "" ? null : JSON.parse(text)) as Record<string, unknown> | null,
        };
      };
      const names = async (actor: string) =>
        ((await call(actor, "GET", "")).body?.codes as { name: string; order: number }[]).map(
          (code) => `${code.order}:${code.name}`,
        );

      expect((await call("", "GET", "")).status).toBe(401);
      expect(await names("D")).toEqual([]);

      const ids: string[] = [];
      for (const name of ["Odnos prema mentoru", "Vrijeme i rokovi", "Izvori"]) {
        const created = await call("D", "POST", "", { name, description: "Izmišljeni opis." });
        expect(created.status).toBe(201);
        ids.push(created.body?.id as string);
      }
      expect(await names("D")).toEqual(["1:Odnos prema mentoru", "2:Vrijeme i rokovi", "3:Izvori"]);

      // Another name in other letters is the same name; a blank or padded one never reaches the database.
      expect((await call("D", "POST", "", { name: "izvori" })).status).toBe(409);
      expect((await call("D", "POST", "", { name: " Izvori " })).status).toBe(422);

      // Rename and move in one call; the others keep their order and are numbered again.
      const patched = await call("D", "PATCH", `/${ids[2]}`, {
        name: "Izvori i literatura",
        order: 1,
      });
      expect([patched.status, patched.body?.name, patched.body?.order]).toEqual([
        200,
        "Izvori i literatura",
        1,
      ]);
      expect(await names("D")).toEqual([
        "1:Izvori i literatura",
        "2:Odnos prema mentoru",
        "3:Vrijeme i rokovi",
      ]);
      expect((await call("D", "PATCH", `/${ids[0]}`, { order: 4 })).status).toBe(422);
      expect((await call("D", "PATCH", `/${ids[0]}`, { name: "Vrijeme i rokovi" })).status).toBe(
        409,
      );
      expect((await call("D", "PATCH", `/${ids[0]}`, {})).status).toBe(422);
      expect(await names("D")).toEqual([
        "1:Izvori i literatura",
        "2:Odnos prema mentoru",
        "3:Vrijeme i rokovi",
      ]);

      // Another student, a teacher, an unknown and a malformed id: the same 404, and nothing changed.
      for (const stranger of ["E", "B"]) {
        expect(await names(stranger)).toEqual([]);
        for (const id of [ids[0]!, ids[0]!.toUpperCase()]) {
          for (const [method, body] of [
            ["PATCH", { name: "Tuđe" }],
            ["DELETE", undefined],
          ] as const) {
            const refused = await call(stranger, method, `/${id}`, body);
            expect([stranger, method, refused.status, refused.body?.code]).toEqual([
              stranger,
              method,
              404,
              "not_found",
            ]);
          }
        }
      }
      for (const id of [MISSING, "not-a-uuid"]) {
        expect((await call("D", "PATCH", `/${id}`, { name: "Nepoznato" })).status).toBe(404);
        expect((await call("D", "DELETE", `/${id}`)).status).toBe(404);
      }
      expect(await names("D")).toEqual([
        "1:Izvori i literatura",
        "2:Odnos prema mentoru",
        "3:Vrijeme i rokovi",
      ]);

      // A code with a marked passage goes only when the owner confirms, and the passage goes with it.
      const store = createQualitativeCodingStore(withActor);
      const material = await store.createMaterial(
        "D".repeat(43),
        "Intervju A",
        "interview",
        "Mentor je rekao da rok vrijedi.",
      );
      await store.createSegment("D".repeat(43), material, ids[1]!, {
        paragraph: 0,
        start: 0,
        end: 6,
        quote: "Mentor",
      });
      expect((await call("D", "DELETE", `/${ids[1]}?confirm=yes`)).status).toBe(422);
      expect((await call("D", "DELETE", `/${ids[1]}`)).status).toBe(409);
      expect((await call("D", "DELETE", `/${ids[1]}?confirm=false`)).status).toBe(422);
      expect(await names("D")).toHaveLength(3);
      expect((await call("D", "DELETE", `/${ids[1]}?confirm=true`)).status).toBe(204);
      expect(await store.listSegments("D".repeat(43), material)).toEqual([]);
      expect(await names("D")).toEqual(["1:Izvori i literatura", "2:Odnos prema mentoru"]);

      // A code without passages needs no confirmation.
      expect((await call("D", "DELETE", `/${ids[2]}`)).status).toBe(204);
      expect(await names("D")).toEqual(["1:Odnos prema mentoru"]);
      expect(await names("E")).toEqual([]);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
}, 120_000);

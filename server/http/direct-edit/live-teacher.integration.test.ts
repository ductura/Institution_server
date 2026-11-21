// The teacher path of PUT /api/v1/live/{documentId} (SRV-1702; D-34, D-244) on
// a real server with the real pipeline: `If-Match: "<etag>"` (64 lower-case hex,
// the ETag of the state read) goes to the direct-edit port, never to the
// student's publish; any other form stays 428; the database's refusal of a
// teacher without direct edits on is the same 404 as any refused write. The
// database itself is db/main/tests/200-teacher-direct-edit.sql. All values are
// invented.
import { afterEach, expect, it } from "vitest";

import type { ActorReader, LiveStates, TeacherEditOutcome } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createLiveRoutes } from "../live.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "A".repeat(43);
const HASH = "4f".repeat(32);
const NEW_TOKEN = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8fb";
const BODY =
  '{"nodes":[{"children":[{"marks":[],"text":"Izmišljeni tekst rada.","type":"text"}],"id":"0f1e2d3c-4b5a-4968-8776-655443322110","type":"paragraph"}],"schemaVersion":1}';

let server: Running | undefined;
const calls: unknown[][] = [];
let answer: TeacherEditOutcome = { status: "accepted", token: NEW_TOKEN };

async function start(withTeacherPath = true) {
  const states: LiveStates = {
    publish: async (...args) => {
      calls.push(["student", ...args]);
      return { status: "accepted", token: NEW_TOKEN };
    },
    read: async () => ({ status: "empty" }),
  };
  const actors = {
    currentActor: async () => ({
      userId: "9d8c7b6a-5f4e-4c3b-9a2d-1e0f9a8b7c01",
      institutionId: "7b6a5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c01",
    }),
  } as unknown as ActorReader;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createLiveRoutes({
      states,
      actors,
      recordActivity: async () => undefined,
      ...(withTeacherPath
        ? {
            teacherEdits: {
              publishTeacherEdit: async (...args) => {
                calls.push(["teacher", ...args]);
                return answer;
              },
            },
          }
        : {}),
    }),
  });
}
afterEach(async () => {
  calls.length = 0;
  answer = { status: "accepted", token: NEW_TOKEN };
  await server?.close();
  server = undefined;
});

const put = (ifMatch: string) =>
  fetch(`http://127.0.0.1:${server!.port}/api/v1/live/izmisljeni-rad-0001`, {
    method: "PUT",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `__Host-ductus_session=${TOKEN}`,
      "if-match": ifMatch,
    },
    body: BODY,
  });

it("sends an ETag precondition to the teacher's port with the hash read and the exact text", async () => {
  await start();
  const response = await put(`"${HASH}"`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ outcome: "accepted", token: NEW_TOKEN });
  expect(calls).toEqual([["teacher", TOKEN, "izmisljeni-rad-0001", HASH, BODY]]);
});

it("keeps a token precondition on the student's publish", async () => {
  await start();
  expect((await put(`"${NEW_TOKEN}"`)).status).toBe(200);
  expect(calls.map((c) => c[0])).toEqual(["student"]);
});

it("answers a teacher's conflict with a null token, a refusal with 404 and a fault with 503", async () => {
  await start();
  answer = { status: "conflict", token: null };
  const conflict = await put(`"${HASH}"`);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toEqual({ outcome: "conflict", token: null });
  answer = { status: "not_found" };
  expect((await put(`"${HASH}"`)).status).toBe(404);
  answer = { status: "invalid" };
  expect((await put(`"${HASH}"`)).status).toBe(422);
  answer = { status: "unavailable" };
  expect((await put(`"${HASH}"`)).status).toBe(503);
});

it.each([
  ["an upper-case ETag", `"${HASH.toUpperCase()}"`],
  ["a weak ETag", `W/"${HASH}"`],
  ["an unquoted ETag", HASH],
  ["a short hash", `"${HASH.slice(2)}"`],
])("refuses %s with 428 before the database", async (_name, sent) => {
  await start();
  expect((await put(sent)).status).toBe(428);
  expect(calls).toEqual([]);
});

it("without the teacher's port an ETag precondition is 428, as before SRV-1702", async () => {
  await start(false);
  expect((await put(`"${HASH}"`)).status).toBe(428);
  expect(calls).toEqual([]);
});

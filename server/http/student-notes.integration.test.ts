import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";
import { createStudentNotesRoutesFor } from "./student-notes.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "D".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const NOTE_ID = "00000000-0000-4000-8000-00000000019a";
const INSTANT = "2026-11-20T15:30:00.000Z";
const POST_HEADERS = { cookie: COOKIE, origin: ORIGIN, "content-type": "application/json" };

let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function fixture() {
  const stored: object[] = [];
  const query = vi.fn(async (sql: string, values?: readonly unknown[]): Promise<object[]> => {
    if (sql.includes("app.add_submission_note")) {
      const row = { id: NOTE_ID, text: values?.[1], createdAt: new Date(INSTANT) };
      stored.push(row);
      return [row];
    }
    if (sql.includes("app.submission_notes")) return stored;
    return [];
  });
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await query(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createStudentNotesRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1/student`;
  return {
    get: `${base}/assignments/${ASSIGNMENT}/submission-notes`,
    post: `${base}/submission-notes`,
    query,
  };
}

it("adds and rereads a note without exposing a method to change or remove it", async () => {
  const { get, post } = await fixture();
  const text = "🌱".repeat(600);
  const body = JSON.stringify({ assignmentId: ASSIGNMENT, text });
  const added = await fetch(post, { method: "POST", headers: POST_HEADERS, body });
  const note = { id: NOTE_ID, text, createdAt: INSTANT };
  expect(added.status).toBe(201);
  expect(added.headers.get("cache-control")).toBe("no-store");
  expect(await added.json()).toEqual(note);

  for (const method of ["PATCH", "PUT", "DELETE"]) {
    expect((await fetch(post, { method, headers: POST_HEADERS })).status).toBe(405);
  }
  const read = await fetch(get, { headers: { cookie: COOKIE } });
  expect(read.status).toBe(200);
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect(await read.json()).toEqual({ notes: [note] });
});

it("refuses bad origin, oversized bodies, bad JSON and invalid note input before SQL", async () => {
  const { get, post, query } = await fixture();
  const valid = { assignmentId: ASSIGNMENT, text: "Izmišljena napomena" };
  const send = (body: string, headers = POST_HEADERS) =>
    fetch(post, { method: "POST", headers, body });
  expect(
    (await send(JSON.stringify(valid), { ...POST_HEADERS, origin: "https://other.invalid" }))
      .status,
  ).toBe(403);
  expect((await send("{x")).status).toBe(400);
  expect((await send("a".repeat(8193))).status).toBe(413);
  for (const invalid of [
    { ...valid, text: "" },
    { ...valid, text: "🌱".repeat(601) },
    { ...valid, studentId: NOTE_ID },
  ]) {
    const response = await send(JSON.stringify(invalid));
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ code: "invalid_input" });
  }
  expect((await fetch(get)).status).toBe(401);
  expect(
    (await fetch(get.replace(ASSIGNMENT, "%zz"), { headers: { cookie: COOKIE } })).status,
  ).toBe(404);
  expect(query).not.toHaveBeenCalled();
});

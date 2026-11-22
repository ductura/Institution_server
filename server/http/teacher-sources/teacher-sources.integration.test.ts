// The guidance of a teacher on sources over HTTP (SRV-1605) on a real server and
// pipeline, with the real port over a fake withActor that answers as the RPCs
// do: the holder writes, a collaborator only reads, everybody else is refused
// with ZD403 (the one 404 of C-23). Every value is invented.
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createTeacherSourceRoutes } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const HOLDER = "H".repeat(43);
const COLLAB = "K".repeat(43);
const STUDENT = "S".repeat(43);
const STRANGER = "X".repeat(43);
const SIGNED_OUT = "C".repeat(43);
const BROKEN = "D".repeat(43);
const DOC = "dokument-izmisljeni-a1";
const SRC = "00000000-0000-4000-8000-00000000c5a1";
const PROOF = "00000000-0000-4000-8000-00000000d5a1";
const COURSE = "00000000-0000-4000-8000-0000000000c1";
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const STUDENT_ID = "00000000-0000-4000-8000-000000000104";
const T0 = "2026-11-30T10:00:00.000Z";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });
const record = {
  id: SRC,
  type: "book",
  authors: [{ kind: "person", family: "Horvat", given: "Ivan" }],
  year: 2020,
  title: "Izmišljena knjiga",
  place: "Zagreb",
  publisher: "Izmišljeni izdavač",
};
const source = (extra = {}) => ({
  id: SRC,
  record,
  doi: null,
  isbn: null,
  undated: false,
  createdAt: T0,
  updatedAt: T0,
  ...extra,
});
const proofRequest = {
  id: "00000000-0000-4000-8000-00000000e5a1",
  sourceId: SRC,
  instruction: "Priložite stranicu 14.",
  dueAt: "2099-01-01T10:00:00.000Z",
  createdAt: T0,
  closedAt: null,
};

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** The holder writes; the collaborator reads; the student owns the work; the stranger has no relation. */
async function fixture(options: { breakAnswer?: boolean } = {}) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  const touched = vi.fn(async (_token: string) => undefined);
  const withActor: WithActor = async (token, run) => {
    if (token === SIGNED_OUT) throw coded("ZD401");
    if (token === BROKEN) throw new Error("baza je pala");
    return run({
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        const writes =
          /teacher_source_recommend|teacher_source_unrecommend|teacher_proof_request|teacher_literature_seen|course_literature_(put|delete)/.test(
            sql,
          );
        if (token === STRANGER) throw coded("ZD403");
        if (writes && token !== HOLDER) throw coded("ZD403");
        if (/student_proof_requests/.test(sql) && token !== STUDENT) throw coded("ZD403");
        if (/origin_work_access/.test(sql)) {
          if (token === STUDENT)
            return {
              rows: [{ assignmentId: ASSIGNMENT, studentId: STUDENT_ID, isOwner: true }] as Row[],
              rowCount: 1,
            };
          return {
            rows: [{ assignmentId: ASSIGNMENT, studentId: STUDENT_ID, isOwner: false }] as Row[],
            rowCount: 1,
          };
        }
        if (/teacher_source_guidance/.test(sql)) {
          if (token === STUDENT) throw coded("ZD403");
          const answer = options.breakAnswer
            ? { canWrite: "yes" }
            : {
                canWrite: token === HOLDER,
                sources: [{ ...source({ requirement: "required" }), proofCount: 1 }],
                proofRequests: [proofRequest],
                literatureSeenAt: null,
              };
          return { rows: [{ answer }] as Row[], rowCount: 1 };
        }
        if (/teacher_source_recommend/.test(sql)) {
          return { rows: [{ answer: source({ requirement: values[2] }) }] as Row[], rowCount: 1 };
        }
        if (
          /teacher_source_unrecommend|teacher_proof_request_close|course_literature_delete/.test(
            sql,
          )
        ) {
          return { rows: [{ done: false }] as Row[], rowCount: 1 };
        }
        if (/teacher_proof_request_put/.test(sql)) {
          return {
            rows: [{ answer: { ...proofRequest, instruction: values[2] } }] as Row[],
            rowCount: 1,
          };
        }
        if (/teacher_literature_seen_put/.test(sql))
          return { rows: [{ seenAt: T0 }] as Row[], rowCount: 1 };
        if (/source_proofs\(/.test(sql))
          return { rows: [{ id: PROOF, page: "14", note: null }] as Row[], rowCount: 1 };
        if (/read_source_proof_image/.test(sql))
          return { rows: [{ image: JPEG }] as Row[], rowCount: 1 };
        if (/course_literature_read/.test(sql)) {
          const sources = [
            {
              id: SRC,
              record,
              doi: null,
              isbn: null,
              undated: false,
              createdAt: T0,
              updatedAt: T0,
            },
          ];
          return {
            rows: [{ answer: { canWrite: token === HOLDER, sources } }] as Row[],
            rowCount: 1,
          };
        }
        if (/course_literature_put/.test(sql)) {
          if (values[2] === "10.1000/dvaput") throw coded("ZD409");
          return {
            rows: [
              {
                answer: {
                  id: SRC,
                  record,
                  doi: values[2],
                  isbn: null,
                  undated: false,
                  createdAt: T0,
                  updatedAt: T0,
                },
              },
            ] as Row[],
            rowCount: 1,
          };
        }
        if (/student_proof_requests/.test(sql))
          return { rows: [{ answer: { proofRequests: [proofRequest] } }] as Row[], rowCount: 1 };
        return { rows: [{ touched: true }] as Row[], rowCount: 1 };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createTeacherSourceRoutes({ withActor, recordActivity: touched }),
  });
  return { base: `http://127.0.0.1:${running.port}`, calls, touched };
}

const cookie = (token: string) => `__Host-ductus_session=${token}`;
const get = (url: string, token = HOLDER) => fetch(url, { headers: { cookie: cookie(token) } });
const send = (
  method: string,
  url: string,
  body?: unknown,
  token = HOLDER,
  headers: Record<string, string> = {},
) =>
  fetch(url, {
    method,
    headers: {
      cookie: cookie(token),
      origin: ORIGIN,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const works = (base: string) => `${base}/api/v1/teacher/works/${DOC}`;

describe("teacher source guidance", () => {
  it("is read by the holder with canWrite and by a collaborator without", async () => {
    const { base } = await fixture();
    const holder = await get(`${works(base)}/source-guidance`);
    expect(holder.status).toBe(200);
    expect(holder.headers.get("cache-control")).toBe("no-store");
    expect(((await holder.json()) as { canWrite: boolean }).canWrite).toBe(true);
    const collaborator = await get(`${works(base)}/source-guidance`, COLLAB);
    expect(((await collaborator.json()) as { canWrite: boolean }).canWrite).toBe(false);
  });

  it("answers 401 without a session and 404 for every refusal, alike", async () => {
    const { base } = await fixture();
    expect((await fetch(`${works(base)}/source-guidance`)).status).toBe(401);
    expect((await get(`${works(base)}/source-guidance`, SIGNED_OUT)).status).toBe(401);
    for (const token of [STUDENT, STRANGER]) {
      const refused = await get(`${works(base)}/source-guidance`, token);
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: "not_found" });
    }
  });

  it("is 503 for a database that fails and for an answer outside the contract", async () => {
    const { base } = await fixture({ breakAnswer: true });
    expect((await get(`${works(base)}/source-guidance`, BROKEN)).status).toBe(503);
    expect((await get(`${works(base)}/source-guidance`)).status).toBe(503);
  });
});

describe("source recommendation", () => {
  const url = (base: string) => `${works(base)}/source-recommendations/${SRC}`;
  it("is written by the holder only and records the activity after the commit", async () => {
    const { base, touched } = await fixture();
    const saved = await send("PUT", url(base), { record, requirement: "recommended" });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ id: SRC, requirement: "recommended" });
    expect(touched).toHaveBeenCalledTimes(1);
    for (const token of [COLLAB, STUDENT, STRANGER]) {
      expect(
        (await send("PUT", url(base), { record, requirement: "required" }, token)).status,
      ).toBe(404);
    }
    expect(touched).toHaveBeenCalledTimes(1);
  });

  it("refuses a body the contract does not take before the database is asked", async () => {
    const { base, calls } = await fixture();
    for (const body of [
      { record, requirement: "optional" },
      { record, requirement: "required", extra: true },
      {
        record: { ...record, id: "00000000-0000-4000-8000-00000000c5a2" },
        requirement: "required",
      },
      { record: { id: SRC, type: "book" }, requirement: "required" },
      { record, requirement: "required", doi: "10.1000/ABC" },
      { record, requirement: "required", isbn: "9780306406158" },
    ]) {
      expect((await send("PUT", url(base), body)).status).toBe(422);
    }
    expect(await send("PUT", url(base), null as never)).toHaveProperty("status", 422);
    expect(calls).toHaveLength(0);
  });

  it("answers 415, 400 and 404 for the wrong media type, broken JSON and a malformed id", async () => {
    const { base } = await fixture();
    const plain = await fetch(url(base), {
      method: "PUT",
      headers: { cookie: cookie(HOLDER), origin: ORIGIN, "content-type": "text/plain" },
      body: "{}",
    });
    expect(plain.status).toBe(415);
    const broken = await fetch(url(base), {
      method: "PUT",
      headers: { cookie: cookie(HOLDER), origin: ORIGIN, "content-type": "application/json" },
      body: "{",
    });
    expect(broken.status).toBe(400);
    expect(
      (
        await send("PUT", `${works(base)}/source-recommendations/nije-uuid`, {
          record,
          requirement: "required",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(url(base), {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(403);
  });

  it("is removed with 204 also when there was none, by the holder only", async () => {
    const { base, touched } = await fixture();
    const removed = await send("DELETE", url(base));
    expect(removed.status).toBe(204);
    expect(touched).toHaveBeenCalledTimes(1);
    expect((await send("DELETE", url(base), undefined, COLLAB)).status).toBe(404);
    expect((await send("DELETE", `${works(base)}/source-recommendations/nije-uuid`)).status).toBe(
      404,
    );
    expect((await fetch(url(base), { method: "DELETE" })).status).toBe(403);
  });
});

describe("proof request and literature mark", () => {
  const url = (base: string) => `${works(base)}/sources/${SRC}/proof-request`;
  it("sets a request with an instruction and a deadline, and closes it", async () => {
    const { base } = await fixture();
    const set = await send("PUT", url(base), {
      instruction: "Nova molba.",
      dueAt: "2099-01-01T10:00:00.000Z",
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toMatchObject({ instruction: "Nova molba.", closedAt: null });
    expect((await send("PUT", url(base), { instruction: "Molba.", dueAt: "sutra" })).status).toBe(
      422,
    );
    expect(
      (await send("PUT", url(base), { instruction: "", dueAt: "2099-01-01T10:00:00.000Z" })).status,
    ).toBe(422);
    expect(
      (
        await send(
          "PUT",
          url(base),
          { instruction: "Molba.", dueAt: "2099-01-01T10:00:00.000Z" },
          COLLAB,
        )
      ).status,
    ).toBe(404);
    expect((await send("DELETE", url(base))).status).toBe(204);
    expect((await send("DELETE", url(base), undefined, COLLAB)).status).toBe(404);
  });

  it("marks the literature as reviewed, by the holder only", async () => {
    const { base } = await fixture();
    const marked = await send("PUT", `${works(base)}/literature-seen`);
    expect(marked.status).toBe(200);
    expect(await marked.json()).toEqual({ seenAt: T0 });
    expect((await send("PUT", `${works(base)}/literature-seen`, undefined, COLLAB)).status).toBe(
      404,
    );
    expect(
      (await send("PUT", `${works(base)}/literature-seen`, undefined, SIGNED_OUT)).status,
    ).toBe(401);
  });
});

describe("proofs read by a teacher", () => {
  it("lists the proofs and serves the JPEG to a reader, not to the owner or a stranger", async () => {
    const { base } = await fixture();
    const list = await get(`${works(base)}/sources/${SRC}/proofs`, COLLAB);
    expect(list.status).toBe(200);
    const imagePath = `/api/v1/teacher/works/${DOC}/sources/${SRC}/proofs/${PROOF}/image`;
    expect(await list.json()).toEqual({
      proofs: [{ id: PROOF, page: "14", note: null, imagePath }],
    });
    const image = await get(`${base}${imagePath}`, COLLAB);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await image.arrayBuffer()).equals(JPEG)).toBe(true);
    for (const token of [STUDENT, STRANGER]) {
      expect((await get(`${works(base)}/sources/${SRC}/proofs`, token)).status).toBe(404);
      expect((await get(`${base}${imagePath}`, token)).status).toBe(404);
    }
    expect((await get(`${works(base)}/sources/nije-uuid/proofs`)).status).toBe(404);
  });
});

describe("required literature of a course", () => {
  const url = (base: string) => `${base}/api/v1/teacher/courses/${COURSE}/required-literature`;
  it("is read by teachers with canWrite and by a student without it", async () => {
    const { base } = await fixture();
    expect(((await (await get(url(base))).json()) as { canWrite: boolean }).canWrite).toBe(true);
    expect(((await (await get(url(base), COLLAB)).json()) as { canWrite: boolean }).canWrite).toBe(
      false,
    );
    const student = await get(
      `${base}/api/v1/student/courses/${COURSE}/required-literature`,
      STUDENT,
    );
    expect(student.status).toBe(200);
    const body = (await student.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["sources"]);
    expect(
      (await get(`${base}/api/v1/student/courses/${COURSE}/required-literature`, STRANGER)).status,
    ).toBe(404);
    expect(
      (await get(`${base}/api/v1/student/courses/nije-uuid/required-literature`, STUDENT)).status,
    ).toBe(404);
  });

  it("is written by the holder, a repeated DOI is 409 and a collaborator gets 404", async () => {
    const { base } = await fixture();
    const put = await send("PUT", `${url(base)}/${SRC}`, { record, doi: "10.1000/izmisljeno-1" });
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ doi: "10.1000/izmisljeno-1" });
    expect(
      (await send("PUT", `${url(base)}/${SRC}`, { record, doi: "10.1000/dvaput" })).status,
    ).toBe(409);
    expect((await send("PUT", `${url(base)}/${SRC}`, { record }, COLLAB)).status).toBe(404);
    expect((await send("PUT", `${url(base)}/${SRC}`, { doi: "10.1000/x" })).status).toBe(422);
    expect((await send("DELETE", `${url(base)}/${SRC}`)).status).toBe(204);
    expect((await send("DELETE", `${url(base)}/${SRC}`, undefined, COLLAB)).status).toBe(404);
  });
});

describe("proof requests of the own work", () => {
  it("are read by the student of the work only", async () => {
    const { base } = await fixture();
    const url = `${base}/api/v1/student/assignments/${ASSIGNMENT}/source-proof-requests`;
    const own = await get(url, STUDENT);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ proofRequests: [proofRequest] });
    expect((await get(url, HOLDER)).status).toBe(404);
    expect((await fetch(url)).status).toBe(401);
  });
});

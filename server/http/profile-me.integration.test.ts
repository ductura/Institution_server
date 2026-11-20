// GET /api/v1/me (contract Ductus#2028 c.6993786629 §3.3) on a real server
// with the real pipeline, over a fake reader: every vector of the contract,
// cookie included, and no read without a well-formed session cookie. All
// values are invented.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MyAccount, MyAccountResult } from "../database/index.ts";
import { accountSessionTag, principalScope, sessionTag } from "../session/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createMeRoute } from "./profile-me.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(new URL("../contracts/vectors/profile.me.get.json", import.meta.url), "utf8"),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => VECTORS.find((v) => v.name === name)!;

// Invented internal ids behind the success vectors: their journalScope is
// principalScope of these, so the vectors pin the derivation.
const INSTITUTION = "00000000-0000-4000-8000-0000000000f1";
const PERSON: Record<string, string> = {
  student: "00000000-0000-4000-8000-0000000000a1",
  "teacher-without-name": "00000000-0000-4000-8000-0000000000b2",
};
const signedIn = (v: Vector, userId: string, institutionId = INSTITUTION): MyAccountResult => {
  const account = Object.fromEntries(
    Object.entries(v.response.body).filter(
      ([key]) => key !== "journalScope" && key !== "sessionTag",
    ),
  );
  return { ok: true, value: account as MyAccount, userId, institutionId };
};

let server: Running | undefined;
const reads: string[] = [];
let answer: () => Promise<MyAccountResult>;

async function start(next: () => Promise<MyAccountResult>) {
  answer = next;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [
      createMeRoute(async (token) => {
        reads.push(token);
        return answer();
      }),
    ],
  });
}
afterEach(async () => {
  reads.length = 0;
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

function get(headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port: server!.port, method: "GET", path: "/api/v1/me", headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const tokenOf = (v: Vector) => v.request.headers!.cookie!.slice("__Host-ductus_session=".length);
const withoutRequestId = (body: unknown) =>
  Object.fromEntries(
    Object.entries(body as Record<string, unknown>).filter(([k]) => k !== "requestId"),
  );

describe("GET /api/v1/me", () => {
  it.each(["student", "teacher-without-name"])("answers the %s vector", async (name) => {
    const v = vector(name);
    await start(async () => signedIn(v, PERSON[name]!));
    const got = await get(v.request.headers);
    expect(got).toEqual({ status: 200, body: v.response.body });
    expect(v.response.body.journalScope).toBe(principalScope(PERSON[name]!, INSTITUTION));
    expect(v.response.body.sessionTag).toBe(accountSessionTag(tokenOf(v)));
    expect(reads).toEqual([tokenOf(v)]);
  });

  it("journalScope is 64 lowercase hex and names no internal id", async () => {
    const v = vector("student");
    await start(async () => signedIn(v, PERSON.student!));
    const got = await get(v.request.headers);
    const body = got.body as Record<string, unknown>;
    expect(body.journalScope).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(body)).not.toContain(PERSON.student);
    expect(JSON.stringify(body)).not.toContain(INSTITUTION);
  });

  it("the same person has the same journalScope in another session", async () => {
    const v = vector("student");
    await start(async () => signedIn(v, PERSON.student!));
    const first = await get(v.request.headers);
    const second = await get({ cookie: `__Host-ductus_session=${"d".repeat(43)}` });
    expect(second.status).toBe(200);
    expect((second.body as Record<string, unknown>).journalScope).toBe(
      (first.body as Record<string, unknown>).journalScope,
    );
    expect(reads).toEqual([tokenOf(v), "d".repeat(43)]);
  });

  it("two people, or one id in two institutions, have different journalScopes", async () => {
    const v = vector("student");
    const other = "00000000-0000-4000-8000-0000000000c3";
    const scopes: unknown[] = [];
    for (const [userId, institutionId] of [
      [PERSON.student!, INSTITUTION],
      [other, INSTITUTION],
      [PERSON.student!, "00000000-0000-4000-8000-0000000000f2"],
    ] as const) {
      await start(async () => signedIn(v, userId, institutionId));
      scopes.push(((await get(v.request.headers)).body as Record<string, unknown>).journalScope);
      await server?.close();
      server = undefined;
    }
    expect(new Set(scopes).size).toBe(3);
  });

  it("sessionTag is 64 lowercase hex and names no session value", async () => {
    const v = vector("student");
    await start(async () => signedIn(v, PERSON.student!));
    const got = await get(v.request.headers);
    const body = got.body as Record<string, unknown>;
    expect(body.sessionTag).toMatch(/^[0-9a-f]{64}$/);
    expect(body.sessionTag).not.toBe(body.journalScope);
    const text = JSON.stringify(body);
    for (const secret of [tokenOf(v), PERSON.student!, INSTITUTION]) {
      expect(text).not.toContain(secret);
    }
    // Neither the database's token digest nor the ended mark's tag.
    const digest = createHash("sha256").update(tokenOf(v), "utf8").digest("hex");
    expect(body.sessionTag).not.toBe(digest);
    expect(body.sessionTag).not.toBe(sessionTag(tokenOf(v)));
  });

  it("the same session has the same sessionTag on every read", async () => {
    const v = vector("student");
    await start(async () => signedIn(v, PERSON.student!));
    const first = await get(v.request.headers);
    const second = await get(v.request.headers);
    expect((second.body as Record<string, unknown>).sessionTag).toBe(
      (first.body as Record<string, unknown>).sessionTag,
    );
  });

  it("a new login of the same person has another sessionTag", async () => {
    const v = vector("student");
    await start(async () => signedIn(v, PERSON.student!));
    const first = (await get(v.request.headers)).body as Record<string, unknown>;
    const again = (await get({ cookie: `__Host-ductus_session=${"e".repeat(43)}` })).body as Record<
      string,
      unknown
    >;
    expect(again.journalScope).toBe(first.journalScope);
    expect(again.sessionTag).not.toBe(first.sessionTag);
  });

  it("two people signed in at once have different sessionTags", async () => {
    const student = vector("student");
    const teacher = vector("teacher-without-name");
    await start(async () => signedIn(student, PERSON.student!));
    const a = (await get(student.request.headers)).body as Record<string, unknown>;
    answer = async () => signedIn(teacher, PERSON["teacher-without-name"]!);
    const b = (await get(teacher.request.headers)).body as Record<string, unknown>;
    expect(a.sessionTag).not.toBe(b.sessionTag);
  });

  it("401 sends no sessionTag", async () => {
    await start(async () => ({ ok: false, reason: "unauthenticated" }));
    const got = await get(vector("student").request.headers);
    expect(got.status).toBe(401);
    expect(got.body).not.toHaveProperty("sessionTag");
  });

  it("401 without a cookie, before any read", async () => {
    await start(async () => ({ ok: false, reason: "unauthenticated" }));
    const got = await get();
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      401,
      vector("unauthorized").response.body,
    ]);
    expect(reads).toEqual([]);
  });

  it("401 when the database finds no live session behind the cookie", async () => {
    const v = vector("student");
    await start(async () => ({ ok: false, reason: "unauthenticated" }));
    const got = await get(v.request.headers);
    expect(got.status).toBe(401);
    expect(reads).toEqual([tokenOf(v)]);
  });

  it("403 for a cross-site request, before any read", async () => {
    const v = vector("forbidden");
    await start(async () => ({ ok: false, reason: "unauthenticated" }));
    const got = await get(v.request.headers);
    expect([got.status, withoutRequestId(got.body)]).toEqual([403, v.response.body]);
    expect(reads).toEqual([]);
  });

  it("503 when the read fails", async () => {
    const v = vector("unavailable");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await start(async () => {
      throw new Error("down");
    });
    const got = await get(v.request.headers);
    expect([got.status, withoutRequestId(got.body)]).toEqual([503, v.response.body]);
  });
});

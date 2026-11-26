// SRV-V22-ISVU-POPIS: the two trial ISVU source routes on a real server with
// the real pipeline, over a fake caller reader and a fake RosterImports port.
// The source is the real synthetic adapter (invented data). Every vector that
// does not frame the body itself is sent. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type { RosterImportCandidate, RosterPreviewOutcome } from "../../database/index.ts";
import {
  createSyntheticIsvu,
  isvuPortFor,
  readIsvuSetting,
  type IsvuPort,
} from "../../external/isvu/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createIsvuSourceRoutes, parseIsvuImportBody, type IsvuCaller } from "./index.ts";

type Vector = {
  name: string;
  kind: "success" | "error";
  code?: string;
  request: {
    params?: Record<string, string>;
    query?: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (route: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${route}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const COURSE_VECTORS = vectorsOf("institution.isvu-courses.get");
const PREVIEW_VECTORS = vectorsOf("institution.isvu-roster-imports.post");
const framed = (v: Vector) =>
  v.request.rawBody !== undefined || v.request.headers["content-length"] !== undefined;
const ORIGIN = PREVIEW_VECTORS[0]!.request.headers.origin!;
const COURSE = PREVIEW_VECTORS[0]!.request.params!.courseId!;
const COOKIE = PREVIEW_VECTORS[0]!.request.headers.cookie!;
const withoutRequestId = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== "requestId"));

const mock = readIsvuSetting({ format: "ductura-faculty-isvu-v1", mode: "mock" });
const off = readIsvuSetting({ format: "ductura-faculty-isvu-v1", mode: "off" });

let server: Running | undefined;
let caller: IsvuCaller;
let setting = mock;
let previewAnswer: (c: readonly RosterImportCandidate[]) => RosterPreviewOutcome;
const previews: [string, string, string, readonly RosterImportCandidate[]][] = [];
const activity: string[] = [];
const slugs: (string | null)[] = [];
const source: IsvuPort = createSyntheticIsvu();

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createIsvuSourceRoutes({
      readCaller: async () => caller,
      imports: {
        preview: async (token, courseId, kind, candidates) => {
          previews.push([token, courseId, kind, candidates]);
          return previewAnswer(candidates);
        },
        confirm: async () => ({ status: "unavailable" }) as never,
      },
      portFor: (slug) => {
        slugs.push(slug);
        return isvuPortFor(setting, source);
      },
      recordActivity: async (token) => {
        activity.push(token);
      },
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  previews.length = 0;
  activity.length = 0;
  slugs.length = 0;
  caller = { kind: "ok", institutionSlug: "demo-fakultet" };
  setting = mock;
  await server?.close();
  server = undefined;
});
caller = { kind: "ok", institutionSlug: "demo-fakultet" };

const coursesPath = "/api/v1/institution/admin/isvu/courses";
const previewPath = (id: string) => `/api/v1/institution/admin/courses/${id}/isvu-roster-imports`;
const get = async (query: string, headers: Record<string, string> = { cookie: COOKIE }) => {
  const got = await fetch(`http://127.0.0.1:${server!.port}${coursesPath}${query}`, { headers });
  return { status: got.status, body: (await got.json()) as Record<string, unknown> };
};
async function post(path: string, v: Vector, body: unknown = v.request.body) {
  const got = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
    method: "POST",
    headers: v.request.headers,
    body: JSON.stringify(body),
  });
  return { status: got.status, body: (await got.json()) as Record<string, unknown> };
}
const queryOf = (v: Vector) => (v.request.query ? `?${new URLSearchParams(v.request.query)}` : "");
const REFUSAL: Record<string, IsvuCaller> = {
  unauthorized: { kind: "unauthorized" },
  forbidden: { kind: "forbidden" },
  unavailable: { kind: "unavailable" },
};

describe("GET /api/v1/institution/admin/isvu/courses", () => {
  it.each(COURSE_VECTORS.map((v) => [v.name, v] as const))(
    "answers the %s vector",
    async (_n, v) => {
      // not_found stands for a faculty whose setting is off.
      if (v.code === "not_found") setting = off;
      else if (v.code !== undefined && REFUSAL[v.code]) caller = REFUSAL[v.code]!;
      await start();
      const got = await get(queryOf(v), v.request.headers);
      expect([got.status, withoutRequestId(got.body)]).toEqual([
        v.response.status,
        withoutRequestId(v.response.body),
      ]);
    },
  );

  it("asks the setting of the caller's own institution only after who the caller is", async () => {
    caller = { kind: "forbidden" };
    setting = off;
    await start();
    // not an administrator: 403, never the 404 of an off setting
    expect((await get("?academicYear=2026%2F2027")).status).toBe(403);
    expect(slugs).toEqual([]);
    caller = { kind: "ok", institutionSlug: "demo-fakultet-b" };
    expect((await get("?academicYear=2026%2F2027")).status).toBe(404);
    expect(slugs).toEqual(["demo-fakultet-b"]);
  });

  it("refuses other queries before reading the caller", async () => {
    await start();
    for (const query of [
      "",
      "?academicYear=",
      "?academicYear=2026",
      "?academicYear=2026%2F2027&x=1",
      "?academicYear=2026%2F2027&academicYear=2025%2F2026",
      "?x=1",
    ]) {
      expect((await get(query)).status, query).toBe(422);
    }
    expect(slugs).toEqual([]);
  });
});

describe("POST /api/v1/institution/admin/courses/{courseId}/isvu-roster-imports", () => {
  it.each(PREVIEW_VECTORS.filter((v) => !framed(v)).map((v) => [v.name, v] as const))(
    "answers the %s vector",
    async (_name, v) => {
      const success = v.response.body;
      if (v.kind === "success") {
        previewAnswer = (candidates) => ({
          status: "previewed",
          importId: success.importId as string,
          expiresAt: success.expiresAt as string,
          statuses: candidates.map((candidate) => {
            const row = (success.rows as Record<string, unknown>[]).find(
              (one) => one.identifier === candidate.identifier,
            )!;
            return (row.status === "unsuitable" ? row.reason : row.status) as never;
          }),
        });
      } else {
        if (v.code !== undefined && REFUSAL[v.code]) caller = REFUSAL[v.code]!;
        previewAnswer = () => ({ status: "not_found" }) as never;
      }
      await start();
      const got = await post(previewPath(v.request.params!.courseId!), v);
      expect([got.status, withoutRequestId(got.body)]).toEqual([
        v.response.status,
        withoutRequestId(v.response.body),
      ]);
      expect(activity).toEqual(v.kind === "success" ? [expect.any(String)] : []);
    },
  );

  const ok = (): RosterPreviewOutcome => ({
    status: "previewed",
    importId: "5d1c2b3a-4f5e-4a6b-9c7d-8e9f0a1b2c41",
    expiresAt: "2026-11-26T10:30:00.000Z",
    statuses: ["new", "already_enrolled", "unknown_account"],
  });
  const vector = () => PREVIEW_VECTORS.find((x) => x.name === "preview")!;

  it("sends the database the source's rows as source isvu, the course in lower case", async () => {
    previewAnswer = ok;
    await start();
    expect((await post(previewPath(COURSE.toUpperCase()), vector())).status).toBe(200);
    expect(previews).toEqual([
      [
        expect.any(String),
        COURSE,
        "isvu",
        [
          expect.objectContaining({ identifier: "demo-student-3@demo.ductus.test" }),
          expect.objectContaining({ identifier: "demo-student-4@demo.ductus.test" }),
          expect.objectContaining({ identifier: "demo-izvor-1@demo.ductus.test" }),
        ],
      ],
    ]);
  });

  it("is 404 for another institution's course (the database's word), nothing enrolled", async () => {
    previewAnswer = () => ({ status: "not_found" }) as never;
    await start();
    expect((await post(previewPath(COURSE), vector())).status).toBe(404);
    expect(activity).toEqual([]);
  });

  it("is 404 when the setting is off or the source has no such course, before the database", async () => {
    setting = off;
    await start();
    expect((await post(previewPath(COURSE), vector())).status).toBe(404);
    setting = mock;
    expect((await post(previewPath(COURSE), vector(), { sourceCourseKey: "SYN-999" })).status).toBe(
      404,
    );
    expect(previews).toEqual([]);
  });

  it("is 403 for a caller who is not an administrator even when the setting is off", async () => {
    setting = off;
    caller = { kind: "forbidden" };
    await start();
    expect((await post(previewPath(COURSE), vector())).status).toBe(403);
    expect(previews).toEqual([]);
  });

  it("refuses other bodies and a bad course id before the source", async () => {
    await start();
    for (const body of [
      {},
      { sourceCourseKey: "" },
      { sourceCourseKey: 1 },
      { sourceCourseKey: "a b" },
      { sourceCourseKey: "x".repeat(65) },
      { sourceCourseKey: "SYN-101", extra: 1 },
      [],
      null,
    ]) {
      expect((await post(previewPath(COURSE), vector(), body)).status, JSON.stringify(body)).toBe(
        422,
      );
    }
    expect((await post(previewPath("nije-uuid"), vector())).status).toBe(422);
    expect(previews).toEqual([]);
    expect(slugs).toEqual([]);
  });
});

describe("parseIsvuImportBody", () => {
  it("takes exactly {sourceCourseKey}", () => {
    expect(parseIsvuImportBody({ sourceCourseKey: "SYN-101" })).toEqual({
      sourceCourseKey: "SYN-101",
    });
    for (const value of [null, [], "x", {}, { sourceCourseKey: "a b" }, { sourceCourseKey: 1 }]) {
      expect(parseIsvuImportBody(value)).toBeNull();
    }
  });
});

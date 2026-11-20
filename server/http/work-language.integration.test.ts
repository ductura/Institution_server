// The three work language routes on a real server with the real pipeline,
// over the real institution service and a fake WorkLanguages port: every
// vector of the three contracts a socket can reach is sent as its bytes; a
// refusal before the port leaves it uncalled. Port of the HTTP edge of Ductus
// work-language-route.ts at 078c780 (DAN-386). All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { InstitutionCourses, InstitutionMembers, WorkLanguages } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createInstitutionCourseRoutes } from "./institution-courses.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: {
    params: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (id: string): Vector[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${id}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;

type Kind = "assignment" | "student" | "document";
const BASE = "/api/v1/institution/assignments";
const ROUTES: Record<
  Kind,
  { id: string; method: string; path: (p: Record<string, string>) => string }
> = {
  assignment: {
    id: "institution.work-language.post",
    method: "setAssignmentWorkLanguage",
    path: (p) => `${BASE}/${p.assignmentId}/work-language`,
  },
  student: {
    id: "institution.student-work-language.post",
    method: "setWorkLanguage",
    path: (p) => `${BASE}/${p.assignmentId}/students/${p.studentId}/work-language`,
  },
  document: {
    id: "institution.work-work-language.post",
    method: "setWorkLanguageForDocument",
    path: (p) =>
      `${BASE}/${p.assignmentId}/works/${encodeURIComponent(p.documentId!)}/work-language`,
  },
};
const ORIGIN = vectorsOf(ROUTES.assignment.id)[0]!.request.headers.origin!;

let server: Running | undefined;
const calls: { method: string; args: unknown[] }[] = [];
const activity: string[] = [];
let outcome: unknown;

async function start() {
  const record =
    (method: string) =>
    async (...args: unknown[]) => {
      calls.push({ method, args });
      return outcome;
    };
  const languages = {
    setAssignmentWorkLanguage: record("setAssignmentWorkLanguage"),
    setWorkLanguage: record("setWorkLanguage"),
    setWorkLanguageForDocument: record("setWorkLanguageForDocument"),
  } as unknown as WorkLanguages;
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createInstitutionCourseRoutes({
      courses: {} as InstitutionCourses,
      members: {} as InstitutionMembers,
      languages,
      recordActivity: async (token) => activity.push(token),
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  calls.length = 0;
  activity.length = 0;
  outcome = undefined;
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
function send(raw: Buffer): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(raw);
    const finish = (): Answer => {
      const [head = "", ...rest] = text.split("\r\n\r\n");
      const headers: Record<string, string> = {};
      for (const field of head.split("\r\n").slice(1)) {
        const at = field.indexOf(":");
        headers[field.slice(0, at).toLowerCase()] = field.slice(at + 1).trim();
      }
      return { status: Number(head.split(" ")[1]), head: headers, body: rest.join("\r\n\r\n") };
    };
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (!text.includes("\r\n\r\n")) return;
      const got = finish();
      if (Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

function raw(path: string, headers: [string, string][], body: string): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const framed = all.some(([k]) => /^(content-length|transfer-encoding)$/i.test(k));
  if (!framed) all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `POST ${path} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]);
}

// A short body under a longer Content-Length is a wait or a client gone on a
// real socket; the reader's own 400 is mutation-request.test.ts.

const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);
const REFUSED: Record<string, unknown> = {
  forbidden: { status: "forbidden" },
  conflict: { status: "conflict" },
  unavailable: { status: "unavailable", reason: "database_error" },
};
/** The port's outcome of each vector that reaches it. */
function outcomeOf(name: string, body: Record<string, unknown>): unknown {
  return name === "set" || name === "removed" ? { status: "updated", ...body } : REFUSED[name];
}

const cases = (Object.keys(ROUTES) as Kind[]).flatMap((kind) =>
  vectorsOf(ROUTES[kind].id)
    .filter((v) => !UNREACHABLE.has(v.name))
    .map((v) => [`${ROUTES[kind].id} ${v.name}`, kind, v] as const),
);

describe("every vector a socket can reach", () => {
  it.each(cases)("%s", async (_name, kind, v) => {
    outcome = outcomeOf(v.name, v.response.body);
    await start();
    const body = v.request.rawBody ?? JSON.stringify(v.request.body);
    const path = ROUTES[kind].path(v.request.params);
    const got = await send(raw(path, Object.entries(v.request.headers), body));
    expect(got.status).toBe(v.response.status);
    if (v.name === "content-length-invalid") return; // Node's parser answers it itself.
    expect(got.head["content-type"]?.split(";")[0]).toBe("application/json");
    expect(got.head["cache-control"]).toBe("no-store");
    const json = JSON.parse(got.body) as Record<string, unknown>;
    if (got.status === 200) expect(json).toEqual(v.response.body);
    else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
    const token = v.request.headers.cookie?.slice("__Host-ductus_session=".length);
    if (outcome === undefined) expect(calls).toEqual([]);
    else expect(calls.map((c) => [c.method, c.args[0]])).toEqual([[ROUTES[kind].method, token]]);
    expect(activity).toEqual(got.status === 200 ? [token] : []);
  });
});

describe("what reaches the port", () => {
  const set = (kind: Kind) => vectorsOf(ROUTES[kind].id).find((v) => v.name === "set")!;
  const headers = Object.entries(set("assignment").request.headers);
  const { assignmentId, studentId } = set("student").request.params as Record<string, string>;

  it("each route passes its path ids, in order, and the checked body", async () => {
    outcome = { status: "updated", version: 4 };
    await start();
    const a = set("assignment");
    expect(
      (
        await send(
          raw(ROUTES.assignment.path(a.request.params), headers, JSON.stringify(a.request.body)),
        )
      ).status,
    ).toBe(200);
    outcome = { status: "updated", language: "hr" };
    const removal = '{"language":null}';
    expect(
      (
        await send(
          raw(
            ROUTES.student.path({ assignmentId: assignmentId!, studentId: studentId! }),
            headers,
            removal,
          ),
        )
      ).status,
    ).toBe(200);
    const document = "izmišljeni rad / 01";
    expect(
      (
        await send(
          raw(
            ROUTES.document.path({ assignmentId: assignmentId!, documentId: document }),
            headers,
            removal,
          ),
        )
      ).status,
    ).toBe(200);
    expect(calls).toEqual([
      { method: "setAssignmentWorkLanguage", args: [activity[0], assignmentId, 3, "en"] },
      { method: "setWorkLanguage", args: [activity[0], assignmentId, studentId, null] },
      { method: "setWorkLanguageForDocument", args: [activity[0], assignmentId, document, null] },
    ]);
  });

  it("a document id that is no work id is 422 without a call; an assignment id that is no UUID too", async () => {
    outcome = { status: "updated", language: "en" };
    await start();
    const body = '{"language":"en"}';
    for (const documentId of ["%20rad", "rad%20", "a%00b", "%E0%A4%A", "x".repeat(257)]) {
      const path = `${BASE}/${assignmentId}/works/${documentId}/work-language`;
      expect((await send(raw(path, headers, body))).status).toBe(422);
    }
    const path = `${BASE}/nije-uuid/works/rad/work-language`;
    expect((await send(raw(path, headers, body))).status).toBe(422);
    expect(calls).toEqual([]);
    const longest = `${BASE}/${assignmentId}/works/${"x".repeat(256)}/work-language`;
    expect((await send(raw(longest, headers, body))).status).toBe(200);
  });

  it.each<[string, string]>([
    ["assignment", '{"expectedVersion":0,"language":"en"}'],
    ["assignment", '{"expectedVersion":2147483648,"language":"en"}'],
    ["assignment", '{"expectedVersion":3,"language":null}'],
    ["assignment", '{"expectedVersion":3,"language":"en","x":1}'],
    ["student", '{"language":"EN"}'],
    ["student", "{}"],
    ["student", '{"language":"en","studentId":"x"}'],
    ["document", '{"language":" en"}'],
    ["document", "[]"],
  ])("%s refuses %s with 422 before the port", async (kind, body) => {
    outcome = { status: "updated", language: "en", version: 4 };
    await start();
    const params = { assignmentId: assignmentId!, studentId: studentId!, documentId: "rad" };
    const got = await send(raw(ROUTES[kind as Kind].path(params), headers, body));
    expect(got.status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("the port's invalid is 422, an unknown status 503", async () => {
    for (const [answer, status] of [
      [{ status: "invalid" }, 422],
      [{ status: "version_conflict" }, 503],
    ] as const) {
      outcome = answer;
      await start();
      const a = set("assignment");
      const got = await send(
        raw(ROUTES.assignment.path(a.request.params), headers, JSON.stringify(a.request.body)),
      );
      expect(got.status).toBe(status);
      await server?.close();
      server = undefined;
    }
  });
});

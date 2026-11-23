// SRV-ADMIN-2: the two roster import routes on a real server with the real
// pipeline, over a fake RosterImports port. Every vector that does not frame
// the body itself is sent. The file is read by the route; only its well formed
// rows reach the port. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import {
  ROSTER_IMPORT_MAX_CSV_LENGTH as CONTRACT_MAX_CSV,
  ROSTER_IMPORT_MAX_ROWS as CONTRACT_MAX_ROWS,
} from "../contracts/index.ts";
import type {
  RosterConfirmOutcome,
  RosterImportCandidate,
  RosterPreviewOutcome,
} from "../database/index.ts";
import { ROSTER_IMPORT_MAX_CSV_LENGTH, ROSTER_IMPORT_MAX_ROWS } from "../institution/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createRosterImportRoutes, parseRosterImportBody } from "./roster-imports.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  kind: "success" | "error";
  code?: string;
  request: {
    params: Record<string, string>;
    headers: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  };
  response: { status: number; body: Record<string, unknown> };
};
const vectorsOf = (route: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../contracts/vectors/${route}.json`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const PREVIEW_VECTORS = vectorsOf("institution.roster-imports.post");
const CONFIRM_VECTORS = vectorsOf("institution.roster-import-confirm.post");
const framed = (v: Vector) =>
  v.request.rawBody !== undefined || v.request.headers["content-length"] !== undefined;
const ORIGIN = PREVIEW_VECTORS[0]!.request.headers.origin!;
const PORT_REFUSAL: ReadonlyMap<string, string> = new Map([
  ["forbidden", "forbidden"],
  ["not_found", "not_found"],
  ["unavailable", "unavailable"],
  ["import_expired", "expired"],
]);

let server: Running | undefined;
const previews: [string, string, string, readonly RosterImportCandidate[]][] = [];
const confirms: [string, string][] = [];
const activity: string[] = [];
let previewAnswer: (candidates: readonly RosterImportCandidate[]) => RosterPreviewOutcome;
let confirmAnswer: () => RosterConfirmOutcome;

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createRosterImportRoutes({
      imports: {
        preview: async (token, courseId, source, candidates) => {
          previews.push([token, courseId, source, candidates]);
          return previewAnswer(candidates);
        },
        confirm: async (token, importId) => {
          confirms.push([token, importId]);
          return confirmAnswer();
        },
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
  confirms.length = 0;
  activity.length = 0;
  await server?.close();
  server = undefined;
});

const previewPath = (courseId: string) =>
  `/api/v1/institution/admin/courses/${courseId}/roster-imports`;
const confirmPath = (importId: string) =>
  `/api/v1/institution/admin/roster-imports/${importId}/confirm`;

async function send(path: string, v: Vector, body = v.request.body) {
  const got = await fetch(`http://127.0.0.1:${server!.port}${path}`, {
    method: "POST",
    headers: v.request.headers,
    body: JSON.stringify(body),
  });
  return { status: got.status, body: (await got.json()) as Record<string, unknown> };
}
type ConfirmBody = {
  enrolled: number;
  alreadyEnrolled: number;
  skipped: number;
  alreadyConfirmed: boolean;
};
const withoutRequestId = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== "requestId"));
const refusal = (code: string) =>
  ({ status: PORT_REFUSAL.get(code) ?? "unexpected", reason: "database_error" }) as never;

describe("the limits", () => {
  it("are the contract's", () => {
    expect([ROSTER_IMPORT_MAX_CSV_LENGTH, ROSTER_IMPORT_MAX_ROWS]).toEqual([
      CONTRACT_MAX_CSV,
      CONTRACT_MAX_ROWS,
    ]);
  });
});

describe("POST /api/v1/institution/admin/courses/{courseId}/roster-imports", () => {
  // roster-too-many-rows names the code only; the test below sends such a file.
  it.each(
    PREVIEW_VECTORS.filter((v) => !framed(v) && v.name !== "roster-too-many-rows").map(
      (v) => [v.name, v] as const,
    ),
  )("answers the %s vector", async (_name, v) => {
    const success = v.response.body;
    previewAnswer =
      v.kind === "success"
        ? (candidates) => ({
            status: "previewed",
            importId: success.importId as string,
            expiresAt: success.expiresAt as string,
            statuses: candidates.map((candidate) => {
              const row = (success.rows as Record<string, unknown>[]).find(
                (one) => one.identifier === candidate.identifier && one.reason !== "duplicate",
              )!;
              return (row.status === "unsuitable" ? row.reason : row.status) as never;
            }),
          })
        : () => refusal(v.code!);
    await start();
    const got = await send(previewPath(v.request.params.courseId!), v);
    expect([got.status, withoutRequestId(got.body)]).toEqual([
      v.response.status,
      withoutRequestId(v.response.body),
    ]);
    expect(activity).toEqual(v.kind === "success" ? [expect.any(String)] : []);
  });

  it("sends the port only the well formed, distinct rows, the course in lower case", async () => {
    const v = PREVIEW_VECTORS.find((x) => x.name === "preview")!;
    previewAnswer = (candidates) => ({
      status: "previewed",
      importId: v.response.body.importId as string,
      expiresAt: v.response.body.expiresAt as string,
      statuses: candidates.map(() => "new"),
    });
    await start();
    const courseId = v.request.params.courseId!;
    expect((await send(previewPath(courseId.toUpperCase()), v)).status).toBe(200);
    expect(previews).toEqual([
      [
        expect.any(String),
        courseId,
        "merlin",
        [
          expect.objectContaining({ identifier: "ana.izmisljena@fakultet.invalid" }),
          expect.objectContaining({ identifier: "marko.izmisljeni@fakultet.invalid" }),
          expect.objectContaining({ identifier: "nepoznata.osoba@fakultet.invalid" }),
        ],
      ],
    ]);
  });

  it("refuses a file of too many rows, and other bodies, before the port", async () => {
    const v = PREVIEW_VECTORS.find((x) => x.name === "roster-too-many-rows")!;
    await start();
    const rows = Array.from(
      { length: ROSTER_IMPORT_MAX_ROWS + 1 },
      (_, at) => `s${at}@f.invalid;A;B`,
    );
    const csv = `identifikator;ime;prezime\n${rows.join("\n")}`;
    const path = previewPath(v.request.params.courseId!);
    const got = await send(path, v, { source: "merlin", csv });
    expect([got.status, got.body.code]).toEqual([422, "roster_too_many_rows"]);
    for (const body of [
      { source: "moodle", csv: "" },
      { source: "merlin" },
      { source: "merlin", csv: "", extra: 1 },
      { source: "merlin", csv: "x".repeat(ROSTER_IMPORT_MAX_CSV_LENGTH + 1) },
    ]) {
      expect((await send(path, v, body)).status).toBe(422);
    }
    expect(previews).toEqual([]);
  });
});

describe("POST /api/v1/institution/admin/roster-imports/{importId}/confirm", () => {
  it.each(CONFIRM_VECTORS.filter((v) => !framed(v)).map((v) => [v.name, v] as const))(
    "answers the %s vector",
    async (_name, v) => {
      confirmAnswer =
        v.kind === "success"
          ? () => ({ status: "confirmed", ...(v.response.body as ConfirmBody) })
          : () => refusal(v.code!);
      await start();
      const got = await send(confirmPath(v.request.params.importId!), v);
      expect([got.status, withoutRequestId(got.body)]).toEqual([
        v.response.status,
        withoutRequestId(v.response.body),
      ]);
      expect(activity).toEqual(v.kind === "success" ? [expect.any(String)] : []);
    },
  );

  it("passes the import id in lower case and takes only {}", async () => {
    const v = CONFIRM_VECTORS.find((x) => x.name === "confirmed")!;
    confirmAnswer = () => ({ status: "confirmed", ...(v.response.body as ConfirmBody) });
    await start();
    const importId = v.request.params.importId!;
    expect((await send(confirmPath(importId.toUpperCase()), v)).status).toBe(200);
    expect(confirms).toEqual([[expect.any(String), importId]]);
    for (const body of [{ x: 1 }, [], null]) {
      expect((await send(confirmPath(importId), v, body)).status).toBe(422);
    }
    expect(confirms).toHaveLength(1);
  });
});

describe("parseRosterImportBody", () => {
  it("takes exactly {source, csv}", () => {
    expect(parseRosterImportBody({ source: "isvu", csv: "a" })).toEqual({
      source: "isvu",
      csv: "a",
    });
    expect(parseRosterImportBody({ csv: "a", source: "merlin" })).toEqual({
      source: "merlin",
      csv: "a",
    });
    for (const value of [null, [], "x", { source: "isvu" }, { source: "isvu", csv: 1 }]) {
      expect(parseRosterImportBody(value)).toBeNull();
    }
  });
});

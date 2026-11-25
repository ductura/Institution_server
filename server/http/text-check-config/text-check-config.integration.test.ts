// GET /api/v1/student/assignments/{assignmentId}/text-check-config (SRV-1101)
// on a real server and pipeline, over a fake withActor holding two invented
// institutions: different configuration, null profile, 404 for an assignment
// outside the workspace, and an answer without any work content.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";
import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createTextCheckConfigRoute } from "./index.ts";

const ID_A = "00000000-0000-4000-8000-0000000000a1";
const ID_B = "00000000-0000-4000-8000-0000000000b1";
const COOKIE = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/student.text-check-config.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: { request: { headers?: { cookie: string } } }[] }
).vectors[0]!.request.headers!.cookie;

type Fake = { assignments: string[]; settings: { key: string | null; value: unknown }[] };
// Tokens are matched on the cookie value: one per invented institution.
const INSTITUTIONS: Record<string, Fake> = {
  [COOKIE.split("=")[1]!]: {
    assignments: [ID_A],
    settings: [
      { key: "lekta.profile", value: "agr-diplomski" },
      { key: "citation.style", value: "apa" },
    ],
  },
};
const SECOND = "izmisljeni-token-druge-ustanove-00000000000";
INSTITUTIONS[SECOND] = { assignments: [ID_B], settings: [{ key: null, value: null }] };
// A third institution whose stored style is outside the catalogue (a stale row).
const THIRD = "izmisljeni-token-trece-ustanove-00000000000";
INSTITUTIONS[THIRD] = {
  assignments: [ID_B],
  settings: [{ key: "citation.style", value: "mla" }],
};

const withActor = (async (token: string, fn: (tx: unknown) => Promise<unknown>) => {
  const fake = INSTITUTIONS[token];
  if (token === "izmisljeni-token-odjavljen-0000000000000000")
    throw Object.assign(new Error("no session"), { code: "ZD401" });
  if (token === "izmisljeni-token-pokvaren-00000000000000000") throw new Error("down");
  return fn({
    async query(sql: string, params: string[] = []) {
      if (sql.includes("student_workspace"))
        return { rows: fake!.assignments.includes(params[0]!) ? [{ "?column?": 1 }] : [] };
      if (sql.includes("read_institution_values")) return { rows: fake!.settings };
      throw new Error(`unexpected sql ${sql}`);
    },
  });
}) as never;

let server: Running | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function get(path: string, token?: string) {
  server ??= await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [createTextCheckConfigRoute({ withActor })],
  });
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server!.port,
        path,
        headers: token === undefined ? {} : { cookie: `__Host-ductus_session=${token}` },
      },
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
const url = (id: string) => `/api/v1/student/assignments/${id}/text-check-config`;
const FIRST = COOKIE.split("=")[1]!;

describe("student.text-check-config.get", () => {
  it("keeps the check ids inside the limits of the contract", async () => {
    const body = ROUTES.find((r) => r.id === "student.text-check-config.get")!.responses[0]!
      .body as unknown as {
      properties: { enabledCheckIds: { maxItems: number; items: { maxLength: number } } };
    };
    const { maxItems, items } = body.properties.enabledCheckIds;
    const ids = (await get(url(ID_A), FIRST)).body.enabledCheckIds as string[];
    expect(ids.length).toBeLessThanOrEqual(maxItems);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(items.maxLength);
  });

  it("gives two institutions different configurations", async () => {
    const a = await get(url(ID_A), FIRST);
    const b = await get(url(ID_B), SECOND);
    expect(a).toEqual({
      status: 200,
      body: {
        enabledCheckIds: [
          "paste",
          "claim",
          "long",
          "colloq",
          "absolute",
          "first",
          "term",
          "abbr",
          "hole",
        ],
        lektaProfileId: "agr-diplomski",
        citationStyle: "apa",
      },
    });
    expect(b).toEqual({
      status: 200,
      body: {
        enabledCheckIds: ["paste", "claim", "long", "term", "abbr", "hole"],
        lektaProfileId: null,
        citationStyle: "fpzg",
      },
    });
    expect(Object.keys(a.body).sort()).toEqual([
      "citationStyle",
      "enabledCheckIds",
      "lektaProfileId",
    ]);
  });

  it("answers the default style for an unset or unknown stored style, never the stored text", async () => {
    expect((await get(url(ID_B), THIRD)).body.citationStyle).toBe("fpzg");
    expect((await get(url(ID_B), SECOND)).body.citationStyle).toBe("fpzg");
  });

  it("answers 404 for an assignment outside the caller's workspace, and for a malformed id", async () => {
    expect((await get(url(ID_B), FIRST)).status).toBe(404);
    expect((await get(url("nije-uuid"), FIRST)).status).toBe(404);
  });

  it("answers 401 without a session or with a signed-out one, and 503 when the database fails", async () => {
    expect((await get(url(ID_A))).status).toBe(401);
    expect((await get(url(ID_A), "izmisljeni-token-odjavljen-0000000000000000")).status).toBe(401);
    expect((await get(url(ID_A), "izmisljeni-token-pokvaren-00000000000000000")).status).toBe(503);
  });
});

// SRV-ADMIN-3: GET /api/v1/institution/assistant-setting over the real HTTP
// stack, with the database answer stubbed and an invented faculty switch.
// Who is an administrator is the database's (institution.actor_has_role);
// here the vectors, the 401, 403, 422 and 503 and that nothing reaches the
// database for a refused request. No provider and no model is ever named.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import { AssistantSetting } from "../../contracts/index.ts";
import type { ActorTransaction, WithActor } from "../../database/index.ts";
import type { AssistantSettingSource } from "../../institution/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createAssistantSettingRoute } from "./index.ts";

type Vector = {
  name: string;
  kind: "success" | "error";
  code?: string;
  request: { query?: Record<string, string>; headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/institution.assistant-setting.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;

const PATH = "/api/v1/institution/assistant-setting";
const query = vi.fn();
const withActor: WithActor = (token, run) =>
  run({ query: query.bind(null, token) } as unknown as ActorTransaction);
let source: AssistantSettingSource;
let server: Running;

beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [
      createAssistantSettingRoute({
        withActor,
        source: {
          get assistant() {
            return source.assistant;
          },
          switchOf: (slug) => source.switchOf(slug),
        },
      }),
    ],
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
  source = { assistant: false, switchOf: () => null };
});

const admin = { authenticated: true, admin: true, institutionSlug: "izmisljeni-fakultet" };
const dbError = (code: string) => Object.assign(new Error(code), { code });

function get(v: Vector) {
  const search = new URLSearchParams(v.request.query ?? {}).toString();
  return fetch(`http://127.0.0.1:${server.port}${PATH}${search ? `?${search}` : ""}`, {
    headers: v.request.headers ?? {},
  });
}

it.each(VECTORS.map((v) => [v.name, v] as const))("vector %s", async (_name, v) => {
  if (v.kind === "success") {
    const body = v.response.body as AssistantSetting;
    source = {
      assistant: body.assistant,
      switchOf: () =>
        body.settingVersion === null
          ? null
          : { version: body.settingVersion, transcription: body.transcription, tools: body.tools },
    };
    query.mockResolvedValue({ rows: [admin] });
  } else if (v.name === "teacher-forbidden") {
    query.mockResolvedValue({ rows: [{ ...admin, admin: false }] });
  } else if (v.code === "unavailable") {
    query.mockRejectedValue(dbError("57014"));
  } else {
    query.mockResolvedValue({ rows: [admin] });
  }
  const response = await get(v);
  expect(response.status).toBe(v.response.status);
  const body = (await response.json()) as Record<string, unknown>;
  if (v.kind === "success") {
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Value.Check(AssistantSetting, body)).toBe(true);
    expect(body).toEqual(v.response.body);
  } else {
    expect(body).toEqual({ ...v.response.body, requestId: response.headers.get("x-request-id") });
  }
  if (["unauthorized", "cross-site", "invalid-input"].includes(v.name)) {
    expect(query).not.toHaveBeenCalled();
  }
});

it("a ZD401 of the database is 401 and a ZD403 is 403", async () => {
  const v = VECTORS.find((x) => x.name === "no-setting")!;
  query.mockRejectedValueOnce(dbError("ZD401"));
  expect((await get(v)).status).toBe(401);
  query.mockRejectedValueOnce(dbError("ZD403"));
  expect((await get(v)).status).toBe(403);
});

it("names no provider and no model, and the switch is never changeable", async () => {
  source = {
    assistant: true,
    switchOf: () => ({ version: 4, transcription: true, tools: true }),
  };
  query.mockResolvedValue({ rows: [admin] });
  const response = await get(VECTORS[0]!);
  const body = (await response.json()) as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual([
    "assistant",
    "changeable",
    "settingVersion",
    "tools",
    "transcription",
  ]);
  expect(body.changeable).toBe(false);
});

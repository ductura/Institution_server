// SRV-ED42-PRIJEDLOZI: the HTTP edge of the four suggestion routes. The
// database is a stand-in here (a scripted query per SQL statement); who may
// suggest, read and decide is proven against PostgreSQL in
// db/main/tests/260-collaboration-suggestion.sql and
// server/database/suggestions/suggestions.pg.integration.test.ts. Every id
// and text is invented.
import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createSuggestionRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "S".repeat(43);
const WORK = "izmisljeni-rad-0001";
const NODE = "11111111-1111-4111-8111-111111111111";
const ID = "5a5a5a5a-0000-4000-8000-000000000001";
const TEXT = "Izmišljeni grad ima tri trga.";
const snapshot = (text: string) =>
  `{"nodes":[{"children":[{"marks":[],"text":"${text}","type":"text"}],"id":"${NODE}","type":"paragraph"}],"schemaVersion":1}`;
const HASH = createHash("sha256").update(snapshot(TEXT)).digest("hex");
const ANCHOR = {
  nodeId: NODE,
  quote: "tri trga",
  prefix: "ima ",
  suffix: ".",
  startHint: 20,
  endHint: 28,
};

/** A database error with the SQLSTATE the RPCs raise. */
const refusal = (code: string) => Object.assign(new Error(code), { code });
type Answer = Record<string, unknown>[] | Error;
/** The answer per RPC, matched by its name in the SQL. */
let answers: Record<string, Answer>;
const calls: string[] = [];
const rolledBack: unknown[] = [];
const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => {
  // The RPC's name in camelCase: collaboration.read_live_state is readLiveState.
  const name = (/collaboration\.(\w+)/u.exec(sql)?.[1] ?? "unknown").replace(
    /_(\w)/gu,
    (_, c: string) => c.toUpperCase(),
  );
  calls.push(name);
  const answer = answers[name];
  if (answer === undefined) throw new Error(`unexpected ${name}`);
  if (answer instanceof Error) throw answer;
  return { rows: answer, rowCount: answer.length };
});
const withActor: WithActor = async (_token, run) => {
  try {
    return await run({ query: query as unknown as ActorTransaction["query"] });
  } catch (error) {
    rolledBack.push(error);
    throw error;
  }
};
let server: Running;

beforeEach(async () => {
  answers = {};
  calls.length = 0;
  rolledBack.length = 0;
  query.mockClear();
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createSuggestionRoutesFor({ withActor }),
  });
});
afterEach(() => server.close());

function post(
  path: string,
  body: unknown,
  { token = TOKEN as string | null, type = "application/json" } = {},
) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/suggestions${path}`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      ...(token === null ? {} : { cookie: `__Host-ductus_session=${token}` }),
      "content-type": type,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const codeOf = async (response: Response) =>
  [response.status, ((await response.json()) as { code: string }).code] as const;

const LIVE = [{ outcome: "state", content_hash: HASH, body: snapshot(TEXT) }];
const ROW = {
  suggestionId: ID,
  anchor: ANCHOR,
  text: "četiri trga",
  state: "pending",
  isOwn: true,
  baseHash: HASH,
  createdWindow: new Date("2026-11-26T10:05:00.000Z"),
  decidedWindow: null,
};

describe("the edge before the database", () => {
  it("refuses no session, another media type, bad JSON and a body outside the contract", async () => {
    for (const path of ["", "/list", "/accept", "/reject"]) {
      expect(await codeOf(await post(path, {}, { token: null }))).toEqual([401, "unauthorized"]);
      expect(await codeOf(await post(path, "{}", { type: "text/plain" }))).toEqual([
        415,
        "unsupported_media_type",
      ]);
      expect(await codeOf(await post(path, "{"))).toEqual([400, "invalid_json"]);
      expect(await codeOf(await post(path, []))).toEqual([422, "invalid_input"]);
    }
    for (const body of [{ suggestionId: "nije-uuid" }, { suggestionId: ID, x: 1 }, {}]) {
      expect(await codeOf(await post("/accept", body))).toEqual([422, "invalid_input"]);
      expect(await codeOf(await post("/reject", body))).toEqual([422, "invalid_input"]);
    }
    expect(await codeOf(await post("/list", { documentId: WORK, x: 1 }))).toEqual([
      422,
      "invalid_input",
    ]);
    expect(calls).toEqual([]);
  });

  it("reads a malformed work id as a missing work, before the database", async () => {
    expect(await codeOf(await post("/list", { documentId: " rad" }))).toEqual([404, "not_found"]);
    expect(
      await codeOf(await post("", { anchor: ANCHOR, documentId: "", text: "četiri trga" })),
    ).toEqual([404, "not_found"]);
    expect(calls).toEqual([]);
  });

  it("refuses a text equal to the quote, a control or bidi character, non-NFC text and a wrong range", async () => {
    for (const [anchor, text] of [
      [ANCHOR, "tri trga"],
      [ANCHOR, "a\u0007b"],
      [ANCHOR, "a‮b"],
      [ANCHOR, "é"],
      [ANCHOR, "a\nb"],
      [{ ...ANCHOR, endHint: 29 }, "četiri trga"],
      [{ ...ANCHOR, extra: 1 }, "četiri trga"],
    ] as const) {
      expect(await codeOf(await post("", { anchor, documentId: WORK, text }))).toEqual([
        422,
        "invalid_input",
      ]);
    }
    expect(calls).toEqual([]);
  });
});

describe("collaboration.suggestions-list.post", () => {
  it("answers the rows of the database in the contract's shape", async () => {
    answers = { listSuggestions: [ROW] };
    const response = await post("/list", { documentId: WORK });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      suggestions: [{ ...ROW, createdWindow: "2026-11-26T10:05:00.000Z" }],
    });
  });

  it("another's work is 404, a malformed row 503", async () => {
    answers = { listSuggestions: refusal("ZD404") };
    expect(await codeOf(await post("/list", { documentId: WORK }))).toEqual([404, "not_found"]);
    answers = { listSuggestions: [{ ...ROW, state: "accepted" }] };
    expect(await codeOf(await post("/list", { documentId: WORK }))).toEqual([503, "unavailable"]);
  });
});

describe("collaboration.suggestions.post", () => {
  const body = { anchor: ANCHOR, documentId: WORK, text: "četiri trga" };

  it("stores the suggestion bound to the live state the teacher reads", async () => {
    answers = { readLiveState: LIVE, createSuggestion: [{ id: ID }] };
    const response = await post("", body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ suggestionId: ID, baseHash: HASH });
    expect(query.mock.calls[1]?.[1]).toEqual([WORK, JSON.stringify(ANCHOR), "četiri trga", HASH]);
  });

  it("an anchor that no longer stands is 409 and rolls the stored row back", async () => {
    answers = { readLiveState: LIVE, createSuggestion: [{ id: ID }] };
    const moved = { ...body, anchor: { ...ANCHOR, quote: "dva trga" } };
    expect(await codeOf(await post("", moved))).toEqual([409, "conflict"]);
    expect(rolledBack).toHaveLength(1);
  });

  it("no relation is 404, the owner 403, a moved or submitted state 409", async () => {
    answers = { readLiveState: refusal("ZD403") };
    expect(await codeOf(await post("", body))).toEqual([404, "not_found"]);
    answers = { readLiveState: LIVE, createSuggestion: refusal("ZD403") };
    expect(await codeOf(await post("", body))).toEqual([403, "forbidden"]);
    answers = { readLiveState: LIVE, createSuggestion: refusal("ZD409") };
    expect(await codeOf(await post("", body))).toEqual([409, "conflict"]);
    answers = {
      readLiveState: [{ outcome: "submitted", content_hash: HASH, body: null }],
      createSuggestion: refusal("ZD409"),
    };
    expect(await codeOf(await post("", body))).toEqual([409, "conflict"]);
    answers = { readLiveState: refusal("ZD401") };
    expect(await codeOf(await post("", body))).toEqual([401, "unauthorized"]);
  });
});

describe("collaboration.suggestion-accept.post", () => {
  const decided = [
    {
      documentId: WORK,
      anchor: ANCHOR,
      text: "četiri trga",
      liveHash: HASH,
      liveBody: snapshot(TEXT),
    },
  ];

  it("answers the exact JCS bytes of the applied suggestion for live.document.put", async () => {
    answers = { decideSuggestion: decided };
    const response = await post("/accept", { suggestionId: ID });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      suggestionId: ID,
      state: "accepted",
      baseHash: HASH,
      text: snapshot("Izmišljeni grad ima četiri trga."),
      change: {
        source: "teacher-suggestion",
        suggestionId: ID,
        nodeId: NODE,
        start: 20,
        end: 28,
        removed: "tri trga",
        inserted: "četiri trga",
      },
    });
    expect(query.mock.calls[0]?.[1]).toEqual([ID, "accept"]);
  });

  it("a quote that no longer stands is 409 and the decision is rolled back", async () => {
    answers = {
      decideSuggestion: [
        {
          ...decided[0],
          liveBody: snapshot("Izmišljeni grad nema trgova."),
          liveHash: createHash("sha256")
            .update(snapshot("Izmišljeni grad nema trgova."))
            .digest("hex"),
        },
      ],
    };
    expect(await codeOf(await post("/accept", { suggestionId: ID }))).toEqual([409, "conflict"]);
    expect(rolledBack).toHaveLength(1);
  });

  it("a live state that is not its hash's bytes is not applied", async () => {
    answers = { decideSuggestion: [{ ...decided[0], liveHash: "0".repeat(64) }] };
    expect(await codeOf(await post("/accept", { suggestionId: ID }))).toEqual([409, "conflict"]);
    expect(rolledBack).toHaveLength(1);
  });

  it("the teacher is 403, another's 404, a second decision 409", async () => {
    for (const [code, expected] of [
      ["ZD403", [403, "forbidden"]],
      ["ZD404", [404, "not_found"]],
      ["ZD409", [409, "conflict"]],
      ["XX000", [503, "unavailable"]],
    ] as const) {
      answers = { decideSuggestion: refusal(code) };
      expect(await codeOf(await post("/accept", { suggestionId: ID }))).toEqual(expected);
    }
  });
});

describe("collaboration.suggestion-reject.post", () => {
  it("answers 204 and passes the decision", async () => {
    answers = {
      decideSuggestion: [
        { documentId: WORK, anchor: ANCHOR, text: "x", liveHash: null, liveBody: null },
      ],
    };
    const response = await post("/reject", { suggestionId: ID });
    expect(response.status).toBe(204);
    expect(query.mock.calls[0]?.[1]).toEqual([ID, "reject"]);
  });

  it("the teacher is 403, another's 404, a second decision 409", async () => {
    for (const [code, expected] of [
      ["ZD403", [403, "forbidden"]],
      ["ZD404", [404, "not_found"]],
      ["ZD409", [409, "conflict"]],
    ] as const) {
      answers = { decideSuggestion: refusal(code) };
      expect(await codeOf(await post("/reject", { suggestionId: ID }))).toEqual(expected);
    }
  });
});

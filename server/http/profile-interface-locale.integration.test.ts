// DAN-851-1d1 (contract Ductus#1836 c.6938624974): GET and POST
// /api/v1/profile/interface-locale on a real server with the real pipeline,
// over the real profile service and a fake InterfaceLocaleStore. Every vector
// is sent as its bytes, cookie included (a valid token since 851-1d2). Every
// refusal before the port leaves it uncalled. All values are invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { InterfaceLocaleStore } from "../database/index.ts";

type ReadResult = Awaited<ReturnType<InterfaceLocaleStore["read"]>>;
type SaveResult = Awaited<ReturnType<InterfaceLocaleStore["save"]>>;
type InterfaceLocale = Parameters<InterfaceLocaleStore["save"]>[1];

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createInterfaceLocaleRoutes } from "./profile-interface-locale.ts";
import { type Running, startServer } from "./start.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string>; body?: unknown; rawBody?: string };
  response: { status: number; body: Record<string, unknown> };
};
const load = (file: string) =>
  (
    JSON.parse(readFileSync(new URL(`../contracts/vectors/${file}`, import.meta.url), "utf8")) as {
      vectors: Vector[];
    }
  ).vectors;
const GET_VECTORS = load("profile.interface-locale.get.json");
const POST_VECTORS = load("profile.interface-locale.post.json");
const ORIGIN = POST_VECTORS.find((v) => v.name === "saved")!.request.headers!.origin!;
/** The vectors' own cookie; the cases outside the vectors use it too. */
const COOKIE = GET_VECTORS.find((v) => v.name === "saved")!.request.headers!.cookie!;
const TOKEN = COOKIE.slice("__Host-ductus_session=".length);
const PATH = "/api/v1/profile/interface-locale";
const JSON_TYPE = "application/json";

const fail = (code: string) => ({ ok: false, error: { code, messageKey: "x.y" } }) as const;

let server: Running | undefined;
const calls = { read: [] as string[], save: [] as [string, string][], activity: [] as string[] };
let readAnswer: () => Promise<ReadResult>;
let saveAnswer: (locale: InterfaceLocale) => Promise<SaveResult>;

async function start(
  answers: {
    read?: () => Promise<ReadResult>;
    save?: (locale: InterfaceLocale) => Promise<SaveResult>;
  } = {},
) {
  readAnswer = answers.read ?? (async () => ({ ok: true, value: "hr" }));
  saveAnswer = answers.save ?? (async (locale) => ({ ok: true, value: locale }));
  const store: InterfaceLocaleStore = {
    read: async (token) => {
      calls.read.push(token);
      return readAnswer();
    },
    save: async (token, locale) => {
      calls.save.push([token, locale]);
      return saveAnswer(locale);
    },
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createInterfaceLocaleRoutes({
      store,
      recordActivity: async (token) => {
        calls.activity.push(token);
      },
      timeoutMs: 300,
    }),
  });
}
afterEach(async () => {
  calls.read.length = 0;
  calls.save.length = 0;
  calls.activity.length = 0;
  vi.restoreAllMocks();
  await server?.close();
  server = undefined;
});

type Answer = { status: number; head: Record<string, string>; body: string };
/** A HEAD answer has no body, whatever its Content-Length says. */
function send(raw: Buffer, head = false): Promise<Answer> {
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
      const got = finish();
      if (!text.includes("\r\n\r\n")) return;
      if (head || Buffer.byteLength(got.body) >= Number(got.head["content-length"] ?? 0)) {
        socket.destroy();
        resolve(got);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => resolve(finish()));
  });
}

/** One request as bytes; `headers` is a list so a header can be sent twice. */
function raw(method: string, headers: [string, string][], body?: string | Buffer): Buffer {
  const all: [string, string][] = [["host", "127.0.0.1"], ...headers];
  const declared = all.some(([k]) => k.toLowerCase() === "content-length");
  if (body !== undefined && !declared)
    all.push(["content-length", String(Buffer.byteLength(body))]);
  const head = `${method} ${PATH} HTTP/1.1\r\n${all.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body ?? "")]);
}
const postHeaders = (cookie = COOKIE, type = JSON_TYPE): [string, string][] => [
  ["origin", ORIGIN],
  ["sec-fetch-site", "same-origin"],
  ["content-type", type],
  ["cookie", cookie],
];
const get = (headers: [string, string][] = [["cookie", COOKIE]]) => send(raw("GET", headers));
const post = (body: string | Buffer, headers = postHeaders()) => send(raw("POST", headers, body));
const codeOf = (got: Answer) => (JSON.parse(got.body) as { code: string }).code;
const portUntouched = () => {
  expect(calls.read).toEqual([]);
  expect(calls.save).toEqual([]);
  expect(calls.activity).toEqual([]);
};
function plainHeaders(got: Answer) {
  expect(got.head["content-type"]?.split(";")[0]).toBe(JSON_TYPE);
  expect(got.head["cache-control"]).toBe("no-store");
  expect(got.head["set-cookie"]).toBeUndefined();
}

// A short body under a longer Content-Length is a wait (408) or a client gone
// on a real socket; the reader's own 400 is mutation-request.test.ts.
const UNREACHABLE = new Set(["content-length-mismatch", "body-stream-error"]);

const vectorHeaders = (v: Vector): [string, string][] => Object.entries(v.request.headers ?? {});

describe("every vector a socket can reach", () => {
  const answerFor = (v: Vector) => {
    if (v.name === "unavailable") return fail("INTERFACE_LOCALE_DATABASE_ERROR");
    if (v.name === "not-saved") return { ok: true, value: null } as const;
    return undefined;
  };
  it.each(GET_VECTORS.filter((v) => !UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "GET %s",
    async (_name, v) => {
      const answer = answerFor(v);
      await start(answer === undefined ? {} : { read: async () => answer });
      const got = await get(vectorHeaders(v));
      expect(got.status).toBe(v.response.status);
      plainHeaders(got);
      const body = JSON.parse(got.body) as Record<string, unknown>;
      if (got.status === 200) expect(body).toEqual(v.response.body);
      else expect(body).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
      expect(calls.read).toEqual(["unauthorized", "forbidden"].includes(v.name) ? [] : [TOKEN]);
    },
  );
  it.each(POST_VECTORS.filter((v) => !UNREACHABLE.has(v.name)).map((v) => [v.name, v] as const))(
    "POST %s",
    async (_name, v) => {
      const answer = v.name === "unavailable" ? fail("INTERFACE_LOCALE_DATABASE_ERROR") : undefined;
      await start(answer === undefined ? {} : { save: async () => answer });
      const body = v.request.rawBody ?? JSON.stringify(v.request.body);
      const got = await send(raw("POST", vectorHeaders(v), body));
      expect(got.status).toBe(v.response.status);
      if (v.name === "content-length-invalid") return; // Node's parser answers it itself.
      plainHeaders(got);
      const json = JSON.parse(got.body) as Record<string, unknown>;
      if (got.status === 200) expect(json).toEqual(v.response.body);
      else expect(json).toEqual({ ...v.response.body, requestId: got.head["x-request-id"] });
      const reached = ["saved", "unavailable"].includes(v.name);
      expect(calls.save).toEqual(reached ? [[TOKEN, "en"]] : []);
      expect(calls.activity).toEqual(got.status === 200 ? [TOKEN] : []);
    },
  );
});

describe("the session token, on both methods", () => {
  it.each([
    ["no cookie", ""],
    ["42 characters", `__Host-ductus_session=${TOKEN.slice(1)}`],
    ["44 characters", `${COOKIE}A`],
    ["a plus", `__Host-ductus_session=${TOKEN.slice(1)}+`],
    ["a slash", `__Host-ductus_session=${TOKEN.slice(1)}/`],
    ["a no-break space", `__Host-ductus_session=${TOKEN.slice(1)} `],
    ["two session cookies", `${COOKIE}; ${COOKIE}`],
  ])("%s is 401 and the port is not called", async (_name, cookie) => {
    await start();
    const headers: [string, string][] = cookie === "" ? [] : [["cookie", cookie]];
    const got = await get(headers);
    expect([got.status, codeOf(got)]).toEqual([401, "unauthorized"]);
    const posted = await post('{"locale":"en"}', postHeaders(cookie || "x=y"));
    expect([posted.status, codeOf(posted)]).toEqual([401, "unauthorized"]);
    expect(posted.head.connection).toBe("close");
    portUntouched();
  });

  it("a CR in the cookie is refused by Node's parser before the route", async () => {
    await start();
    const got = await send(
      Buffer.from(
        `GET ${PATH} HTTP/1.1\r\nhost: 127.0.0.1\r\ncookie: ${COOKIE}\rx\r\n\r\n`,
        "latin1",
      ),
    );
    expect(got.status).toBe(400);
    portUntouched();
  });
});

describe("ended-session marks (Ductus liveSessionToken)", () => {
  const tagOf = async () => {
    const { sessionTag } = await import("../session/index.ts");
    return sessionTag(TOKEN)!;
  };
  it("a per-session mark or the old list naming this session reads as no cookie", async () => {
    const tag = await tagOf();
    await start();
    for (const marks of [
      `ductus-ended-${tag}=1`,
      `ductus-ended=aaaa.${tag}`,
      `ductus-ended=${tag}`,
    ]) {
      const got = await get([["cookie", `${COOKIE}; ${marks}`]]);
      expect([got.status, codeOf(got)]).toEqual([401, "unauthorized"]);
      const posted = await post('{"locale":"en"}', postHeaders(`${marks}; ${COOKIE}`));
      expect([posted.status, codeOf(posted)]).toEqual([401, "unauthorized"]);
    }
    portUntouched();
  });

  it("another session's mark and an old list without this tag do not hide it", async () => {
    const tag = await tagOf();
    const other = tag.replace(/^./, (c) => (c === "a" ? "b" : "a"));
    await start();
    const got = await get([
      ["cookie", `${COOKIE}; ductus-ended-${other}=1; ductus-ended=${other}.${tag}x`],
    ]);
    expect(got.status).toBe(200);
    expect(calls.read).toEqual([TOKEN]);
  });
});

describe("GET sec-fetch-site", () => {
  it.each([["cross-site"], ["same-site"], ["none"], ["same-origin, same-origin"]])(
    "%s is 403 and the port is not called",
    async (site) => {
      await start();
      const headers: [string, string][] = [
        ["cookie", COOKIE],
        ...site.split(", ").map((s) => ["sec-fetch-site", s] as [string, string]),
      ];
      const got = await get(headers);
      expect([got.status, codeOf(got)]).toEqual([403, "forbidden"]);
      portUntouched();
    },
  );

  it("one same-origin or none at all passes", async () => {
    await start();
    expect(
      (
        await get([
          ["cookie", COOKIE],
          ["sec-fetch-site", "same-origin"],
        ])
      ).status,
    ).toBe(200);
    expect((await get([["cookie", COOKIE]])).status).toBe(200);
    expect(calls.read).toEqual([TOKEN, TOKEN]);
  });
});

describe("POST early refusals", () => {
  it("no cookie with text/plain is 401: the token comes before the media type", async () => {
    await start();
    const got = await post('{"locale":"en"}', postHeaders("x=y", "text/plain"));
    expect([got.status, codeOf(got)]).toEqual([401, "unauthorized"]);
    portUntouched();
  });

  it.each([["text/plain"], ["application/json5"]])("%s is 415", async (type) => {
    await start();
    const got = await post('{"locale":"en"}', postHeaders(COOKIE, type));
    expect([got.status, codeOf(got)]).toEqual([415, "unsupported_media_type"]);
    expect(got.head.connection).toBe("close");
    portUntouched();
  });

  it("Content-Type sent twice is 415", async () => {
    await start();
    const got = await post('{"locale":"en"}', [...postHeaders(), ["content-type", JSON_TYPE]]);
    expect([got.status, codeOf(got)]).toEqual([415, "unsupported_media_type"]);
    portUntouched();
  });

  it.each([["application/json; charset=utf-8"], ["APPLICATION/JSON"]])(
    "%s passes",
    async (type) => {
      await start();
      expect((await post('{"locale":"en"}', postHeaders(COOKIE, type))).status).toBe(200);
    },
  );
});

describe("refusals of the service", () => {
  it.each([
    ["{", 400, "invalid_json"],
    ['﻿{"locale":"hr"}', 400, "invalid_json"],
    ['{"locale":"hr","locale":"en"}', 422, "invalid_input"],
    ['{"locale": "hr"}', 422, "invalid_input"],
    ['"hr"', 422, "invalid_input"],
    ["[]", 422, "invalid_input"],
    ["null", 422, "invalid_input"],
    ['{"locale":"de"}', 422, "invalid_input"],
  ])("%s is %i %s and the port is not called", async (body, status, code) => {
    await start();
    const got = await post(body);
    expect([got.status, codeOf(got)]).toEqual([status, code]);
    plainHeaders(got);
    portUntouched();
  });
});

describe("outcomes of the port", () => {
  it.each([
    ["INTERFACE_LOCALE_UNAUTHENTICATED", 401, "unauthorized"],
    ["INTERFACE_LOCALE_ROW_MALFORMED", 503, "unavailable"],
    ["INTERFACE_LOCALE_DATABASE_ERROR", 503, "unavailable"],
    ["SOMETHING_ELSE", 503, "unavailable"],
  ])("%s is %i on both methods, and no activity", async (code, status, contract) => {
    await start({ read: async () => fail(code), save: async () => fail(code) });
    const got = await get();
    expect([got.status, codeOf(got)]).toEqual([status, contract]);
    const posted = await post('{"locale":"en"}');
    expect([posted.status, codeOf(posted)]).toEqual([status, contract]);
    expect(calls.activity).toEqual([]);
  });

  it("INTERFACE_LOCALE_INVALID from the port is 422 invalid_input", async () => {
    await start({ save: async () => fail("INTERFACE_LOCALE_INVALID") });
    const got = await post('{"locale":"en"}');
    expect([got.status, codeOf(got)]).toEqual([422, "invalid_input"]);
    expect(calls.activity).toEqual([]);
  });

  it("a port that throws is 503 with one report and no message, token or body", async () => {
    const SECRET = "tajna poruka baze";
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });
    await start({
      read: () => Promise.reject(new Error(SECRET)),
      save: () => Promise.reject(new Error(SECRET)),
    });
    const got = await get();
    const posted = await post('{"locale":"en"}');
    for (const answer of [got, posted]) {
      expect([answer.status, codeOf(answer)]).toEqual([503, "unavailable"]);
      for (const leak of [SECRET, TOKEN, "locale"]) expect(answer.body).not.toContain(leak);
    }
    expect(logged.length).toBe(2);
    for (const line of logged) for (const leak of [SECRET, TOKEN]) expect(line).not.toContain(leak);
    expect(calls.activity).toEqual([]);
  });
});

describe("port calls and activity", () => {
  it("GET reads once with the token and never saves or counts", async () => {
    await start();
    expect(JSON.parse((await get()).body)).toEqual({ locale: "hr" });
    expect(calls).toEqual({ read: [TOKEN], save: [], activity: [] });
  });

  it("POST saves once with the token and counts activity once after 200", async () => {
    await start();
    const got = await post('{"locale":"en"}');
    expect(got.status).toBe(200);
    plainHeaders(got);
    expect(JSON.parse(got.body)).toEqual({ locale: "en" });
    expect(calls).toEqual({ read: [], save: [[TOKEN, "en"]], activity: [TOKEN] });
  });

  it("HEAD is 405 from the router and the port is not called", async () => {
    await start();
    const got = await send(raw("HEAD", [["cookie", COOKIE]]), true);
    expect(got.status).toBe(405);
    expect(got.head.allow).toBe("GET, POST");
    portUntouched();
  });
});

// DAN-851-1d2, QA FAIL on ductura/server#206: a request whose Content-Length
// Node's parser refuses gets the 400 its route's contract promises, over a
// real socket of startServer; any other parse error keeps Node's own bytes.
import { connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";

import { contentLengthBody, refusedRequestLine } from "./client-error.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { type Running, startServer } from "./start.ts";
import { SECURITY_HEADERS } from "./security-header-values.ts";

const ORIGIN = "https://ductura.example.invalid";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const contract = (id: string) => ROUTES.find((r) => r.id === id)!;
let handled = 0;
const route = (id: string): Route => ({
  contract: contract(id),
  handle: async (_request, response) => {
    handled += 1;
    response.writeHead(204).end();
  },
});
const ROUTE_LIST = [route("profile.interface-locale.post"), route("evidence.open.post")];

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: ROUTE_LIST,
  });
});
afterAll(async () => server.close());

/** Every byte the server sends before it closes the connection. */
function exchange(chunks: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(server.port, "127.0.0.1", async () => {
      for (const chunk of chunks) {
        socket.write(chunk);
        await new Promise((r) => setTimeout(r, 20));
      }
    });
    let text = "";
    socket.on("data", (data) => (text += data.toString("latin1")));
    socket.on("close", () => resolve(text));
    socket.on("error", reject);
  });
}

const post = (path: string, length: string) =>
  `POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Length: ${length}\r\n\r\n{}`;

function parse(text: string) {
  const [head = "", body = ""] = text.split("\r\n\r\n");
  const [line = "", ...rest] = head.split("\r\n");
  const headers = Object.fromEntries(
    rest.map((h) => [h.slice(0, h.indexOf(":")).toLowerCase(), h.slice(h.indexOf(":") + 2)]),
  );
  return { line, headers, body };
}

describe("a Content-Length Node's parser refuses", () => {
  it("is the problem 400 content_length_invalid of the contract, before any layer", async () => {
    for (const length of ["-1", "abc", "1x", "+5", "1, 2"]) {
      const { line, headers, body } = parse(
        await exchange([post("/api/v1/profile/interface-locale", length)]),
      );
      expect([length, line]).toEqual([length, "HTTP/1.1 400 Bad Request"]);
      const id = headers["x-request-id"] ?? "";
      expect(id).toMatch(UUID);
      expect(JSON.parse(body)).toEqual({
        error: "content_length_invalid",
        code: "content_length_invalid",
        messageKey: "errors.contentLengthInvalid",
        status: 400,
        requestId: id,
      });
      expect(headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(headers["content-length"]).toBe(String(Buffer.byteLength(body)));
      expect(headers["connection"]).toBe("close");
      for (const { key, value } of SECURITY_HEADERS) expect(headers[key.toLowerCase()]).toBe(value);
      expect(headers["set-cookie"]).toBeUndefined();
    }
    expect(handled).toBe(0);
  });

  it("is {status: bad_request} on an evidence route, as its contract refuses", async () => {
    const { line, body } = parse(await exchange([post("/api/v1/evidence/open", "-1")]));
    expect(line).toBe("HTTP/1.1 400 Bad Request");
    expect(JSON.parse(body)).toEqual({ status: "bad_request" });
  });

  it("two different lengths are refused the same way", async () => {
    const twice = "POST /api/v1/evidence/open HTTP/1.1\r\nHost: x\r\nContent-Length: 2\r\n";
    const text = await exchange([`${twice}Content-Length: 3\r\n\r\n{}`]);
    expect(JSON.parse(parse(text).body)).toEqual({ status: "bad_request" });
  });

  it("is the problem body when the request line came in an earlier packet", async () => {
    const text = await exchange([
      "POST /api/v1/evidence/open HTTP/1.1\r\nHost: x\r\n",
      "Content-Length: -1\r\n\r\n",
    ]);
    expect(JSON.parse(parse(text).body)).toMatchObject({ code: "content_length_invalid" });
  });

  it("an unknown path or another method gets the problem body", async () => {
    const nowhere = JSON.parse(parse(await exchange([post("/api/v1/nowhere", "-1")])).body);
    expect(nowhere).toMatchObject({ code: "content_length_invalid" });
    // The router matches the path without its query, so this is still the evidence route.
    const query = JSON.parse(parse(await exchange([post("/api/v1/evidence/open?x", "-1")])).body);
    expect(query).toEqual({ status: "bad_request" });
    const put = "PUT /api/v1/evidence/open HTTP/1.1\r\nHost: x\r\nContent-Length: -1\r\n\r\n";
    expect(JSON.parse(parse(await exchange([put])).body)).toMatchObject({
      code: "content_length_invalid",
    });
  });
});

describe("any other parse error", () => {
  it("keeps Node's own answer byte for byte", async () => {
    const bad = (status: string) => `HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`;
    expect(await exchange(["POST /x HTTP/1.1\r\nHost: x\r\nCookie: a\x01b\r\n\r\n"])).toBe(
      bad("400 Bad Request"),
    );
    expect(
      await exchange([`GET /x HTTP/1.1\r\nHost: x\r\nX-Big: ${"a".repeat(20_000)}\r\n\r\n`]),
    ).toBe(bad("431 Request Header Fields Too Large"));
    expect(await exchange(["NOT A REQUEST\r\n\r\n"])).toBe(bad("400 Bad Request"));
  });
});

describe("the route of a refused request", () => {
  const routes = ROUTE_LIST;
  const error = (text: string, bytesParsed?: number) =>
    Object.assign(new Error("parse"), { rawPacket: Buffer.from(text, "latin1"), bytesParsed });

  it("is the last request line before the error", () => {
    const two = `${post("/api/v1/profile/interface-locale", "2")}POST /api/v1/evidence/open HTTP/1.1\r\n`;
    expect(refusedRequestLine(error(two))).toEqual({
      method: "POST",
      path: "/api/v1/evidence/open",
    });
    expect(refusedRequestLine(error(two, 20))).toBeNull();
    expect(refusedRequestLine(error("Content-Length: -1\r\n\r\n"))).toBeNull();
    expect(refusedRequestLine(new Error("no packet"))).toBeNull();
  });

  it("chooses the body its contract promises; anything else is the problem", () => {
    const evidence = { method: "POST", path: "/api/v1/evidence/open" };
    expect(contentLengthBody(routes, evidence, "id")).toEqual({ status: "bad_request" });
    for (const line of [
      null,
      { method: "POST", path: "/api/v1/profile/interface-locale" },
      { method: "GET", path: "/api/v1/evidence/open" },
      { method: "POST", path: "/api/v1/evidence/open/" },
    ])
      expect(contentLengthBody(routes, line, "id")).toMatchObject({
        code: "content_length_invalid",
        requestId: "id",
      });
  });
});

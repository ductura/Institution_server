// The pipeline on a real node:http server (S-1B-b, DAN-777): a request a layer
// refuses never reaches the handler, and a state-changing request with a
// foreign Origin gets 403 in the contract's error format. Headers are sent
// raw over a socket, so duplicates arrive as the client sent them.
import { connect } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { createDatabases } from "./databases.ts";
import { HEALTH_ROUTE } from "./health.ts";
import { createLayers, type Layers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { SECURITY_HEADERS } from "./security-headers.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.invalid";
const PATH = "/api/v1/profile/interface-locale";
const contract = ROUTES.find((route) => route.id === "profile.interface-locale.post");
if (contract === undefined) throw new Error("no contract");

let handled = 0;
const spyRoute: Route = {
  contract,
  handle: async (_request, response) => {
    handled += 1;
    response.writeHead(200, { "content-type": "application/json" }).end("{}");
  },
};

async function start(layers: Layers): Promise<Running> {
  return startServer({
    host: "127.0.0.1",
    port: 0,
    layers,
    routes: [HEALTH_ROUTE, spyRoute],
    databases: createDatabases(),
  });
}

type Answer = { status: number; headers: string[]; body: string };

/** One raw HTTP/1.1 request; `lines` are header lines sent as written. */
function send(port: number, method: string, lines: string[] = [], path = PATH): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => {
      const text = Buffer.concat(chunks).toString("latin1");
      const [head = "", raw = ""] = text.split("\r\n\r\n");
      const [status = "", ...headers] = head.split("\r\n");
      // Node chunks a body it answers on a keep-alive HTTP/1.1 request; one chunk here.
      const chunked = headers.some((line) => /^transfer-encoding: chunked$/iu.test(line));
      const body = chunked ? (raw.split("\r\n")[1] ?? "") : raw;
      resolve({ status: Number(status.split(" ")[1]), headers, body });
    });
    const request = [
      `${method} ${path} HTTP/1.1`,
      "Host: 127.0.0.1",
      "Connection: close",
      ...lines,
    ];
    const hasBody = method !== "GET" && method !== "HEAD";
    socket.end(
      `${request.join("\r\n")}${hasBody ? "\r\nContent-Length: 2\r\n\r\n{}" : "\r\n\r\n"}`,
    );
  });
}

/** The problem body of a 403 of the contract (S-1L.3); the request id is new each time. */
const problem = (code: string) => ({
  error: code,
  code,
  messageKey: `errors.${code}`,
  status: 403,
  requestId: expect.stringMatching(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  ),
});

describe("pipeline on a real server", () => {
  let server: Running;
  let refusing: Running;
  beforeAll(async () => {
    server = await start(createLayers({ expectedOrigin: ORIGIN }));
    // Wave 5 stand-in: a rate limit that refuses everything.
    const layers = createLayers({ expectedOrigin: ORIGIN });
    refusing = await start({
      ...layers,
      rateLimit: async (_request, response) => {
        response.writeHead(429, { "content-type": "application/json" }).end('{"error":"x"}');
        return "done";
      },
    });
  });
  afterAll(async () => {
    await server.close();
    await refusing.close();
  });

  it("lets our same-origin POST through to the handler once", async () => {
    handled = 0;
    const answer = await send(server.port, "POST", [
      `Origin: ${ORIGIN}`,
      "Sec-Fetch-Site: same-origin",
    ]);
    expect([answer.status, handled]).toEqual([200, 1]);
  });

  it.each([
    ["a foreign Origin", [`Origin: https://evil.invalid`], "origin_mismatch"],
    ["Origin null", ["Origin: null"], "origin_missing"],
    ["no Origin", [], "origin_missing"],
    ["Origin twice", [`Origin: ${ORIGIN}`, `Origin: ${ORIGIN}`], "origin_mismatch"],
    [
      "Origin twice, ours second",
      ["Origin: https://evil.invalid", `Origin: ${ORIGIN}`],
      "origin_mismatch",
    ],
    [
      "Sec-Fetch-Site cross-site",
      [`Origin: ${ORIGIN}`, "Sec-Fetch-Site: cross-site"],
      "cross_site",
    ],
    [
      "Sec-Fetch-Site twice",
      [`Origin: ${ORIGIN}`, "Sec-Fetch-Site: same-origin", "Sec-Fetch-Site: cross-site"],
      "cross_site",
    ],
  ])(
    "refuses a POST with %s: 403 in the contract format, handler not called",
    async (_, lines, code) => {
      handled = 0;
      const answer = await send(server.port, "POST", lines);
      expect([answer.status, JSON.parse(answer.body), handled]).toEqual([403, problem(code), 0]);
      expect(answer.headers).toContain("Connection: close");
      const names = answer.headers.map((line) => line.split(":")[0]?.toLowerCase());
      for (const { key } of SECURITY_HEADERS) {
        expect(
          names.filter((name) => name === key.toLowerCase()),
          key,
        ).toHaveLength(1);
      }
    },
  );

  it.each(["PUT", "PATCH", "DELETE", "PROPFIND", "PURGE", "MKCOL"])(
    "refuses %s with a foreign Origin before the router",
    async (method) => {
      const answer = await send(server.port, method, ["Origin: https://evil.invalid"]);
      expect([answer.status, JSON.parse(answer.body)]).toEqual([403, problem("origin_mismatch")]);
    },
  );

  it("never lets a lower-case method reach a layer or the handler (Node answers 400)", async () => {
    handled = 0;
    const answer = await send(server.port, "post", [`Origin: ${ORIGIN}`]);
    expect([answer.status, handled]).toEqual([400, 0]);
  });

  it("lets GET through without Origin and with the security headers", async () => {
    const answer = await send(server.port, "GET", [], "/api/v1/health");
    expect(answer.status).toBe(200);
    expect(answer.headers).toContain("X-Frame-Options: DENY");
  });

  it("a refusal of an earlier layer never reaches the handler, even for our origin", async () => {
    handled = 0;
    const post = await send(refusing.port, "POST", [`Origin: ${ORIGIN}`]);
    const get = await send(refusing.port, "GET", [], "/api/v1/health");
    expect([post.status, get.status, handled]).toEqual([429, 429, 0]);
  });

  // Adversarial pass: a refusal kept the connection alive, so Node read and
  // discarded the whole declared body.
  it("closes the connection after a refusal instead of reading a large body", async () => {
    const answer = await new Promise<string>((resolve, reject) => {
      const socket = connect(server.port, "127.0.0.1");
      let text = "";
      socket.on("data", (chunk: Buffer) => (text += chunk.toString("latin1")));
      socket.on("error", reject);
      socket.on("close", () => resolve(text));
      socket.write(`POST ${PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 100000000\r\n\r\n`);
    });
    expect(answer).toMatch(/^HTTP\/1\.1 403 /u);
    expect(answer).toContain("Connection: close");
  });

  it("answers a layer that throws a non-error with 500 and the security headers", async () => {
    const throwing = await start({
      ...createLayers({ expectedOrigin: ORIGIN }),
      clientIp: async () => Promise.reject(null as unknown as Error),
    });
    try {
      handled = 0;
      const answer = await send(throwing.port, "GET", [], "/api/v1/health");
      expect([answer.status, handled]).toEqual([500, 0]);
      expect(answer.headers).toContain("X-Frame-Options: DENY");
    } finally {
      await throwing.close();
    }
  });

  it("refuses every POST when no origin is configured", async () => {
    const closed = await start(createLayers({ expectedOrigin: null }));
    try {
      handled = 0;
      const answer = await send(closed.port, "POST", [`Origin: ${ORIGIN}`]);
      expect([answer.status, JSON.parse(answer.body), handled]).toEqual([
        403,
        problem("origin_mismatch"),
        0,
      ]);
    } finally {
      await closed.close();
    }
  });
});

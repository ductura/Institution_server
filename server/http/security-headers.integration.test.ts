// Port of Ductus src/server/http/security-headers.test.ts at d52a92c3
// (DAN-498), on a real node:http server. Ductus tests a writeHead floor on
// the prototype; here the layer sets the headers before the answer and
// refuse() carries them, so the rows answer after the layer ran.
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import { refuse, SECURITY_HEADERS, securityHeadersLayer } from "./security-headers.ts";

type Row = {
  name: string;
  answer: (res: ServerResponse) => void;
  /** Headers whose value the handler chose; everything else is the layer's. */
  own?: Record<string, string>;
};
const ROUTE_CSP = "default-src 'self'";
const ROWS: Row[] = [
  { name: "implicit end()", answer: (res) => res.end("x") },
  {
    name: "writeHead(status)",
    answer: (res) => {
      res.writeHead(308);
      res.end();
    },
  },
  {
    name: "writeHead(status, object) replaces the layer's value",
    answer: (res) => {
      res.writeHead(200, { "Content-Security-Policy": ROUTE_CSP, "x-frame-options": "SAMEORIGIN" });
      res.end();
    },
    own: { "content-security-policy": ROUTE_CSP, "x-frame-options": "SAMEORIGIN" },
  },
  {
    name: "flushHeaders()",
    answer: (res) => {
      res.statusCode = 400;
      res.flushHeaders();
      res.end();
    },
  },
  { name: "refuse() (a layer's refusal)", answer: (res) => refuse(res, 429, "too_many") },
];

type Handler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

async function fetchHeaders(handle: Handler) {
  const server = createServer((req, res) => void handle(req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<{ status: number; headers: IncomingHttpHeaders; raw: string[] }>(
      (resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/api/v1/x" }, (res) => {
          res.resume();
          res.on("end", () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, raw: res.rawHeaders }),
          );
        });
        req.on("error", reject);
        req.end();
      },
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const count = (raw: string[], key: string) =>
  raw.filter((name, i) => i % 2 === 0 && name.toLowerCase() === key.toLowerCase()).length;

describe("security headers (DAN-498, server-map §3 step 6)", () => {
  it("carries the Ductus values, an API policy that allows nothing and no-store", () => {
    const byKey = Object.fromEntries(SECURITY_HEADERS.map(({ key, value }) => [key, value]));
    expect(byKey["X-Frame-Options"]).toBe("DENY");
    expect(byKey["X-Content-Type-Options"]).toBe("nosniff");
    expect(byKey["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(byKey["Strict-Transport-Security"]).toBe("max-age=63072000; includeSubDomains");
    expect(byKey["Permissions-Policy"]).toMatch(/^camera=\(\), microphone=\(\)/u);
    expect(byKey["Content-Security-Policy"]).toMatch(
      /^default-src 'none';.*frame-ancestors 'none'$/u,
    );
    expect(byKey["Cache-Control"]).toBe("no-store");
    expect(Object.isFrozen(SECURITY_HEADERS)).toBe(true);
  });

  for (const row of ROWS) {
    it(`${row.name}: every header arrives exactly once`, async () => {
      const { raw, headers } = await fetchHeaders(async (req, res) => {
        await securityHeadersLayer(req, res);
        row.answer(res);
      });
      for (const { key, value } of SECURITY_HEADERS) {
        expect(count(raw, key), key).toBe(1);
        expect(headers[key.toLowerCase()], key).toBe(row.own?.[key.toLowerCase()] ?? value);
      }
    });
  }

  it("refuse() carries the headers without the layer (steps 3 to 5 run before it)", async () => {
    const { status, raw } = await fetchHeaders(async (_req, res) => refuse(res, 403, "forbidden"));
    expect(status).toBe(403);
    for (const { key } of SECURITY_HEADERS) expect(count(raw, key), key).toBe(1);
  });

  it("keeps a header the route set before the layer", async () => {
    const { headers } = await fetchHeaders(async (req, res) => {
      res.setHeader("Referrer-Policy", "no-referrer");
      await securityHeadersLayer(req, res);
      res.end();
    });
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });

  it("does nothing once the headers are sent", async () => {
    let threw: unknown;
    await fetchHeaders(async (req, res) => {
      res.flushHeaders();
      try {
        await securityHeadersLayer(req, res);
      } catch (error) {
        threw = error;
      }
      res.end();
    });
    expect(threw).toBeUndefined();
  });

  it("a response without the layer has none of these headers (the test is not vacuous)", async () => {
    const { raw } = await fetchHeaders(async (_req, res) => void res.end());
    for (const { key } of SECURITY_HEADERS) expect(count(raw, key), key).toBe(0);
  });
});

// Port of Ductus src/server/http/security-headers.test.ts at d52a92c3
// (DAN-498), on a real node:http server. Ductus tests a writeHead floor on
// the prototype; here the layer sets the headers before the answer and
// refuse() carries them, so the rows answer after the layer ran. The
// writeHead wrapper of Ductus has its equivalent in enforceSecurityHeaders
// (security/headers.ts), which gets the same rows, the after-the-head case
// and the install-twice case (OSN-B4).
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
import {
  CONTENT_SECURITY_POLICY,
  enforcedHeaders,
  enforceSecurityHeaders,
  PRODUCTION_SECURITY,
} from "./security/index.ts";

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
    name: "writeHead(status, message, object)",
    answer: (res) => {
      res.writeHead(400, "Bad Request", { "Referrer-Policy": "no-referrer" });
      res.end();
    },
    own: { "referrer-policy": "no-referrer" },
  },
  {
    name: "writeHead(status, raw array)",
    answer: (res) => {
      res.writeHead(200, ["Content-Security-Policy", ROUTE_CSP]);
      res.end();
    },
    own: { "content-security-policy": ROUTE_CSP },
  },
  {
    name: "a header set by the route stays",
    answer: (res) => {
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("Content-Security-Policy", ROUTE_CSP);
      res.end();
    },
    own: { "referrer-policy": "no-referrer", "content-security-policy": ROUTE_CSP },
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
    expect(byKey["Content-Security-Policy"]).toBe(
      "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
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
    const { headers, raw } = await fetchHeaders(async (req, res) => {
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", ROUTE_CSP);
      await securityHeadersLayer(req, res);
      res.end();
    });
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-security-policy"]).toBe(ROUTE_CSP);
    for (const { key } of SECURITY_HEADERS) expect(count(raw, key), key).toBe(1);
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

// The writeHead wrapper: the enforced headers (CSP, Permissions-Policy, HSTS)
// are the server's on every way Node writes a head, whatever the route set.
const ENFORCED = enforcedHeaders(PRODUCTION_SECURITY);
const ENFORCED_ROWS: Row[] = [
  ...ROWS.filter((row) => !row.name.startsWith("refuse()")),
  {
    name: "writeHead(status, array of pairs)",
    answer: (res) => {
      res.writeHead(200, [
        ["Content-Security-Policy", ROUTE_CSP],
        ["Permissions-Policy", "camera=*"],
      ]);
      res.end();
    },
  },
  {
    name: "writeHead(status, message, object) with every enforced name",
    answer: (res) => {
      res.writeHead(200, "OK", {
        "content-security-policy": ROUTE_CSP,
        "PERMISSIONS-POLICY": "camera=*",
        "Strict-Transport-Security": "max-age=1",
      });
      res.end();
    },
  },
];

describe("enforced headers on writeHead (DAN-498 floor, SRV-1401)", () => {
  for (const row of ENFORCED_ROWS) {
    it(`${row.name}: every enforced header arrives exactly once, with the server's value`, async () => {
      const { headers, raw } = await fetchHeaders(async (_req, res) => {
        enforceSecurityHeaders(res, PRODUCTION_SECURITY);
        row.answer(res);
      });
      for (const { key, value } of ENFORCED) {
        expect(headers[key.toLowerCase()], key).toBe(value);
        expect(count(raw, key), key).toBe(1);
      }
      expect(headers["content-security-policy"]).toBe(CONTENT_SECURITY_POLICY);
    });
  }

  it("does nothing once the headers are sent", async () => {
    let thrown: unknown = "not called";
    const { status, headers } = await fetchHeaders(async (_req, res) => {
      enforceSecurityHeaders(res, PRODUCTION_SECURITY);
      res.writeHead(204, { "x-frame-options": "SAMEORIGIN" });
      try {
        res.writeHead(500);
        thrown = null;
      } catch (error) {
        thrown = error;
      }
      res.end();
    });
    expect(status).toBe(204);
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN");
    // Node's own writeHead error, not the setHeader one from inside the wrapper.
    expect((thrown as Error).message).toBe(
      "Cannot write headers after they are sent to the client",
    );
  });

  it("wraps writeHead once when enforced twice", async () => {
    let first: unknown;
    let second: unknown;
    const { raw } = await fetchHeaders(async (_req, res) => {
      enforceSecurityHeaders(res, PRODUCTION_SECURITY);
      first = res.writeHead;
      enforceSecurityHeaders(res, { local: true });
      second = res.writeHead;
      res.end();
    });
    expect(second).toBe(first);
    // The first mode stays: HSTS of production, each header once.
    for (const { key } of ENFORCED) expect(count(raw, key), key).toBe(1);
  });

  it("a response without the wrapper has none of these headers (the test is not vacuous)", async () => {
    const { raw } = await fetchHeaders(async (_req, res) => {
      res.writeHead(308);
      res.end();
    });
    for (const { key } of ENFORCED) expect(count(raw, key), key).toBe(0);
  });
});

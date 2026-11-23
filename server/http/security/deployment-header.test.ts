import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  DEPLOYMENT_HEADER,
  ENFORCED_HEADER_NAMES,
  enforcedHeaders,
  enforceSecurityHeaders,
  PRODUCTION_SECURITY,
  type SecurityMode,
} from "./index.ts";

// STG-PRIJAVA (Ductus#2055): a staging server marks every answer
// X-Ductura-Deployment: staging; production and local never send it, even
// when a handler sets it.
async function headOf(
  mode: SecurityMode,
  handle: (response: ServerResponse) => void,
): Promise<Headers> {
  const server = createServer((_request, response) => {
    enforceSecurityHeaders(response, mode);
    handle(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    const answer = await fetch(`http://127.0.0.1:${port}/`);
    await answer.arrayBuffer();
    return answer.headers;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("the staging mark (X-Ductura-Deployment)", () => {
  it("is one of the server's own headers", () => {
    expect(DEPLOYMENT_HEADER).toBe("X-Ductura-Deployment");
    expect(ENFORCED_HEADER_NAMES).toContain("x-ductura-deployment");
  });

  it("is enforced only in the staging mode", () => {
    const mark = (mode: SecurityMode) =>
      enforcedHeaders(mode).filter(({ key }) => key === DEPLOYMENT_HEADER);
    expect(mark({ local: false, staging: true })).toEqual([
      { key: DEPLOYMENT_HEADER, value: "staging" },
    ]);
    expect(mark(PRODUCTION_SECURITY)).toEqual([]);
    expect(mark({ local: true })).toEqual([]);
    expect(mark({ local: false, staging: false })).toEqual([]);
  });

  it("is on every staging answer, an error and a handler's own value included", async () => {
    const staging = { local: false, staging: true };
    const ok = await headOf(staging, (r) => r.end("ok"));
    expect(ok.get(DEPLOYMENT_HEADER)).toBe("staging");
    const failed = await headOf(staging, (r) => {
      r.setHeader(DEPLOYMENT_HEADER, "production");
      r.writeHead(500, { [DEPLOYMENT_HEADER]: "production" });
      r.end();
    });
    expect(failed.get(DEPLOYMENT_HEADER)).toBe("staging");
    expect(failed.get("strict-transport-security")).not.toBeNull();
  });

  it("is never sent by production, even when a handler sets it", async () => {
    const head = await headOf(PRODUCTION_SECURITY, (r) => {
      r.setHeader(DEPLOYMENT_HEADER, "staging");
      r.end("ok");
    });
    expect(head.get(DEPLOYMENT_HEADER)).toBeNull();
    const written = await headOf(PRODUCTION_SECURITY, (r) => {
      r.writeHead(200, { [DEPLOYMENT_HEADER]: "staging" });
      r.end();
    });
    expect(written.get(DEPLOYMENT_HEADER)).toBeNull();
  });
});

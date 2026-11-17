// DAN-1003 (QA on ductura/server#276): `post` settles on every answer. A
// response cut after its headers, or no answer at all, rejects; it never
// leaves the promise pending, which would let a check end with exit code 0.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { post } from "./client.ts";

let server: Server | undefined;

function serve(handler: Parameters<typeof createServer>[1]): Promise<number> {
  server = createServer(handler);
  return new Promise((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve((server!.address() as AddressInfo).port)),
  );
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

describe("post", () => {
  it("rejects a response cut after its headers", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(404, { "content-type": "application/json", "content-length": "100" });
      res.write('{"status":');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await expect(post(port, "/x", {}, "t")).rejects.toThrow();
  });

  it("rejects a connection closed before any answer", async () => {
    const port = await serve((req) => req.socket.destroy());
    await expect(post(port, "/x", {}, "t")).rejects.toThrow();
  });

  it("rejects when no answer comes within the deadline", async () => {
    const port = await serve(() => undefined);
    await expect(post(port, "/x", {}, "t", 100)).rejects.toThrow(/no answer/u);
  });

  it("resolves a complete answer, and a body that is not JSON as {}", async () => {
    const port = await serve((req, res) => {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(req.url === "/json" ? '{"status":"not_found"}' : "<html>");
    });
    await expect(post(port, "/json", {}, "t")).resolves.toEqual({
      status: 404,
      body: { status: "not_found" },
    });
    await expect(post(port, "/html", {}, "t")).resolves.toEqual({ status: 404, body: {} });
  });
});

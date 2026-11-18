// DAN-843-1, review on ductura/server#320 at fc6432b: every request of the
// ops.events.get vectors must reach the answer its vector shows through the
// real step 8 (server/http operatorPolicyLayer), not only match the schema. A
// vector whose cookie step 8 cannot read would make 200, 403, 422 and 503
// unreachable. A cross-area test (docs/server-map.md §2): contracts may not
// import http.
import { readFileSync } from "node:fs";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { operatorPolicyLayer, type SecondFactor } from "../../server/http/index.ts";

type Vector = {
  name: string;
  request: { query?: Record<string, string>; headers?: Record<string, string> };
  response: { status: number };
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../../server/contracts/vectors/ops.events.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };

/** Step 8 over one vector's request, with a second factor that answers `outcome`. */
async function step8(vector: Vector, outcome: Awaited<ReturnType<SecondFactor>>) {
  const request = new IncomingMessage(new Socket());
  request.method = "GET";
  request.url = `/api/v1/ops/events?${new URLSearchParams(vector.request.query).toString()}`;
  for (const [name, value] of Object.entries(vector.request.headers ?? {}))
    request.headers[name.toLowerCase()] = value;
  const response = new ServerResponse(request);
  const seen: string[] = [];
  const layer = operatorPolicyLayer(
    async (token) => {
      seen.push(token);
      return outcome;
    },
    () => undefined,
    () => undefined,
  );
  return { result: await layer(request, response), status: response.statusCode, seen };
}

describe("the requests of ops.events.get through step 8", () => {
  it("has the vectors this table names", () => {
    expect(vectors.map((v) => v.name).sort()).toEqual(
      [
        "empty",
        "no-second-factor",
        "no-session",
        "page",
        "unavailable",
        "window-over-24-hours",
      ].sort(),
    );
  });

  it("no-session: 401 before the second factor is asked", async () => {
    const vector = vectors.find((v) => v.name === "no-session")!;
    expect(vector.response.status).toBe(401);
    const got = await step8(vector, "confirmed");
    expect([got.result, got.status, got.seen]).toEqual(["done", 401, []]);
  });

  it("no-second-factor: its token reaches the port, and unconfirmed is 403", async () => {
    const vector = vectors.find((v) => v.name === "no-second-factor")!;
    expect(vector.response.status).toBe(403);
    const got = await step8(vector, "unconfirmed");
    expect([got.result, got.status, got.seen.length]).toEqual(["done", 403, 1]);
  });

  it.each(["page", "empty", "window-over-24-hours", "unavailable"])(
    "%s: a confirmed operator passes step 8 to the route",
    async (name) => {
      const got = await step8(
        vectors.find((v) => v.name === name)!,
        "confirmed",
      );
      expect([got.result, got.seen.length]).toEqual(["next", 1]);
    },
  );
});

// The record of a step 8 refusal (S-1J.2, DAN-842-3; contract Ductus#1836 c.6947558755):
// one security event per refusal that passes the log catalog, with the route
// only as an exact contract path and nothing of the request besides it.
// Tokens are invented; the clock and the sink are fakes.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { checkEvent } from "../log/index.ts";
import {
  createOperatorRefusalLog,
  operatorPolicyLayer,
  type SecondFactor,
} from "./operator-policy-layer.ts";

const TOKEN = "Izmisljeni_token-operatora_zapis_0000000001";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const NOW = new Date("2026-11-17T12:00:00.000Z");
const INVENTORY = new Set(ROUTES.map((route) => route.path));

function exchange(url: string, cookie?: string) {
  const request = new IncomingMessage(new Socket());
  request.url = url;
  if (cookie !== undefined) request.headers.cookie = cookie;
  return { request, response: new ServerResponse(request) };
}

/** The lines one request leaves, and its status. */
async function run(
  port: SecondFactor,
  url = "/api/v1/ops/x?q=1",
  cookie: string | undefined = COOKIE,
  options: { now?: () => Date; paths?: ReadonlySet<string> } = {},
) {
  const lines: [string, string][] = [];
  const log = createOperatorRefusalLog(
    (level, line) => lines.push([level, line]),
    options.now ?? (() => NOW),
    options.paths,
  );
  const { request, response } = exchange(url, cookie);
  const outcome = await operatorPolicyLayer(port, () => {}, log)(request, response);
  return { lines, outcome, status: response.statusCode, response };
}

const answers =
  (outcome: unknown): SecondFactor =>
  async () =>
    outcome as never;

describe("a refusal of step 8 is recorded", () => {
  it.each([
    ["no cookie", answers("confirmed"), "", 401, "not_signed_in"],
    ["an unknown session", answers("unauthenticated"), COOKIE, 401, "not_signed_in"],
    ["no second factor", answers("unconfirmed"), COOKIE, 403, "second_factor_required"],
    ["a port that is down", answers("unavailable"), COOKIE, 503, "second_factor_unavailable"],
    ["a port that answers toString", answers("toString"), COOKIE, 503, "second_factor_unavailable"],
    [
      "a port that throws",
      (() => {
        throw new Error("down");
      }) as unknown as SecondFactor,
      COOKIE,
      503,
      "second_factor_unavailable",
    ],
  ])("%s: one line the catalog accepts", async (_name, port, cookie, status, reason) => {
    const { lines, outcome, status: sent, response } = await run(port, undefined, cookie);
    expect(outcome).toBe("done");
    expect(sent).toBe(status);
    expect(lines).toHaveLength(1);
    const [level, line] = lines[0]!;
    expect(level).toBe("warn");
    expect(line).not.toContain(TOKEN);
    expect(line).not.toContain("q=1");
    const { level: written, ...record } = JSON.parse(line) as Record<string, unknown>;
    expect(written).toBe("warn");
    expect(record).toEqual({
      time: NOW.toISOString(),
      event: "authz.operator_refused",
      requestId: response.getHeader("x-request-id"),
      accountKind: "anonymous",
      fields: { route: "none", reason },
    });
    expect(checkEvent(record, { routes: INVENTORY }).ok).toBe(true);
  });

  it.each([
    "/api/v1/ops/x",
    "/API/V1/OPS",
    "//api/v1//ops",
    "http://h.invalid/api/v1/ops",
    "/api/v1/ops?route=/api/v1/ops",
  ])("names no route for %s unless it is exactly a contract path", async (url) => {
    const paths = new Set(["/api/v1/ops"]);
    const { lines } = await run(answers("unconfirmed"), url, COOKIE, { paths });
    const route = (JSON.parse(lines[0]![1]) as { fields: { route: string } }).fields.route;
    expect(route).toBe(url === "/api/v1/ops?route=/api/v1/ops" ? "/api/v1/ops" : "none");
  });

  it.each([
    ["sink throws", () => new Date(Number.NaN), "sink"],
    [
      "clock throws",
      (): Date => {
        throw new Error("clock");
      },
      "ok",
    ],
    ["clock gives no date", () => "2026-11-17" as unknown as Date, "ok"],
  ])("a failing log (%s) does not change the answer", async (_name, now, which) => {
    const log = createOperatorRefusalLog(
      which === "sink"
        ? () => {
            throw new Error("sink");
          }
        : () => {},
      now,
    );
    const { request, response } = exchange("/api/v1/ops/x", COOKIE);
    const outcome = await operatorPolicyLayer(
      answers("unconfirmed"),
      () => {},
      log,
    )(request, response);
    expect(outcome).toBe("done");
    expect(response.statusCode).toBe(403);
  });

  it("a passing request and another path leave no line", async () => {
    expect((await run(answers("confirmed"))).lines).toEqual([]);
    expect((await run(answers("unconfirmed"), "/api/v1/health")).lines).toEqual([]);
  });
});

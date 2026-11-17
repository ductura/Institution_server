// The record of a refused operator path (S-1J.2, DAN-842-3; contract
// Ductus#1836 c.6950325128): a catalog record of the log database, or one
// stderr line without a log service; recorded after the refusal answered.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { checkEvent, type LogWriter } from "../log/index.ts";
import { ipRulesLayer } from "./ip-rules-layer.ts";
import {
  createOperatorDenialLog,
  OPERATOR_DENIAL_REASONS,
  type OperatorDenialLog,
  operatorDenialRecord,
} from "./operator-denial-log.ts";
import { operatorPolicyLayer } from "./operator-policy-layer.ts";
import { parseAllowedNetworks } from "../traffic/index.ts";

const REQUEST_ID = "3f2c1a4e-8b7d-4c6e-9f10-2a3b4c5d6e7f";
const AT = new Date("2026-11-17T12:00:00.000Z");
const INVENTORY: ReadonlySet<string> = new Set(ROUTES.map((route) => route.path));

describe("operatorDenialRecord", () => {
  it.each(OPERATOR_DENIAL_REASONS)("makes a record the catalog accepts for %s", (reason) => {
    const record = operatorDenialRecord({ requestId: REQUEST_ID, reason }, AT);
    expect(checkEvent(record, { routes: INVENTORY })).toMatchObject({ ok: true });
    expect(checkEvent(record, { routes: new Set() })).toMatchObject({ ok: true });
  });

  it("step 3 is traffic.ip_denied operator_only, step 8 authz.operator_denied", () => {
    expect(
      operatorDenialRecord({ requestId: REQUEST_ID, reason: "network_not_allowed" }, AT),
    ).toEqual({
      time: AT.toISOString(),
      event: "traffic.ip_denied",
      requestId: REQUEST_ID,
      accountKind: "anonymous",
      fields: { route: "none", rule: "operator_only" },
    });
    expect(
      operatorDenialRecord({ requestId: REQUEST_ID, reason: "second_factor_required" }, AT).fields,
    ).toEqual({ route: "none", reason: "second_factor_required" });
  });

  it.each([
    ["a raw path", "/API/V1/OPS/x"],
    ["a query", "/api/v1/ops/x?token=abc"],
    ["a path that is no route", "/api/v1/ops/x"],
    ["not a string", 7],
  ])("writes none for %s as route", (_name, route) => {
    const record = operatorDenialRecord(
      { requestId: REQUEST_ID, route: route as string, reason: "not_signed_in" },
      AT,
    );
    expect(record.fields.route).toBe("none");
  });

  it("keeps a contract path, and a reason outside the list becomes unavailable", () => {
    const path = ROUTES[0]!.path;
    const record = operatorDenialRecord(
      { requestId: REQUEST_ID, route: path, reason: "toString" as never },
      AT,
    );
    expect(record.fields).toEqual({ route: path, reason: "unavailable" });
  });
});

describe("createOperatorDenialLog", () => {
  it("without a writer writes one stderr line without IP, token or path", () => {
    const lines: [string, string][] = [];
    const log = createOperatorDenialLog({
      sink: (l, line) => lines.push([l, line]),
      now: () => AT,
    });
    log({ requestId: REQUEST_ID, route: "/api/v1/ops/x?t=secret", reason: "session_unknown" });
    expect(lines).toHaveLength(1);
    expect(lines[0]![0]).toBe("warn");
    expect(JSON.parse(lines[0]![1])).toEqual({
      time: AT.toISOString(),
      level: "warn",
      event: "authz.operator_denied",
      requestId: REQUEST_ID,
      fields: { route: "none", reason: "session_unknown" },
    });
    expect(lines[0]![1]).not.toContain("secret");
  });

  it("with a writer hands it the record and never waits for it", () => {
    const records: unknown[] = [];
    const write: LogWriter = (record) => {
      records.push(record);
      return new Promise(() => {}); // never settles
    };
    const log = createOperatorDenialLog({ write, now: () => AT });
    log({ requestId: REQUEST_ID, reason: "network_not_allowed" });
    return Promise.resolve().then(() => {
      expect(records).toEqual([
        operatorDenialRecord({ requestId: REQUEST_ID, reason: "network_not_allowed" }, AT),
      ]);
    });
  });

  it.each([
    ["rejects", (() => Promise.reject(new Error("log database down"))) as LogWriter],
    [
      "throws",
      (() => {
        throw new Error("broken writer");
      }) as LogWriter,
    ],
    [
      "refuses the record",
      (async () => ({
        ok: false,
        error: { code: "LOG_STORE_FAILED", messageKey: "x" },
      })) as unknown as LogWriter,
    ],
  ])("never throws when the writer %s", async (_name, write) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      expect(() =>
        createOperatorDenialLog({ write })({ requestId: REQUEST_ID, reason: "unavailable" }),
      ).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a sink that throws changes nothing", () => {
    const log = createOperatorDenialLog({
      sink: () => {
        throw new Error("stderr closed");
      },
    });
    expect(() => log({ requestId: REQUEST_ID, reason: "not_signed_in" })).not.toThrow();
  });
});

function exchange(url: string): {
  request: IncomingMessage;
  response: ServerResponse;
  order: string[];
} {
  const order: string[] = [];
  const request = new IncomingMessage(new Socket());
  request.method = "GET";
  request.url = url;
  const response = new ServerResponse(request);
  response.assignSocket(
    new Duplex({ read() {}, write: (_c, _e, done) => done() }) as unknown as Socket,
  );
  const writeHead = response.writeHead.bind(response);
  response.writeHead = ((...args: Parameters<typeof writeHead>) => {
    order.push("answer");
    return writeHead(...args);
  }) as typeof response.writeHead;
  return { request, response, order };
}

describe("the layers record after the refusal", () => {
  it.each([
    [
      "step 8",
      (log: OperatorDenialLog) => operatorPolicyLayer(async () => "unconfirmed", undefined, log),
      "not_signed_in",
    ],
    [
      "step 3",
      (log: OperatorDenialLog) => ipRulesLayer(() => parseAllowedNetworks("192.0.2.0/24")!, log),
      "network_not_allowed",
    ],
  ])(
    "%s answers first, then records once with the answer's request id",
    async (_name, make, reason) => {
      const { request, response, order } = exchange("/api/v1/ops/x");
      const entries: Parameters<OperatorDenialLog>[0][] = [];
      const layer = make((entry) => {
        order.push("record");
        entries.push(entry);
      });
      expect(await layer(request, response)).toBe("done");
      expect(order).toEqual(["answer", "record"]);
      expect(entries).toEqual([
        { requestId: response.getHeader("x-request-id"), route: "/api/v1/ops/x", reason },
      ]);
    },
  );

  it("a log that throws leaves the refusal as it is", async () => {
    const { request, response } = exchange("/api/v1/ops/x");
    const layer = operatorPolicyLayer(
      async () => "unconfirmed",
      undefined,
      () => {
        throw new Error("log broken");
      },
    );
    expect(await layer(request, response)).toBe("done");
    expect(response.statusCode).toBe(401);
  });

  it("a pass and a path that is not an operator path record nothing", async () => {
    const entries: unknown[] = [];
    const log: OperatorDenialLog = (entry) => entries.push(entry);
    const confirmed = exchange("/api/v1/ops/x");
    confirmed.request.headers.cookie =
      "__Host-ductus_session=Izmisljeni_token-zapisa_odbijanja_000000001";
    expect(
      await operatorPolicyLayer(
        async () => "confirmed",
        undefined,
        log,
      )(confirmed.request, confirmed.response),
    ).toBe("next");
    const other = exchange("/api/v1/health");
    expect(
      await operatorPolicyLayer(
        async () => "unconfirmed",
        undefined,
        log,
      )(other.request, other.response),
    ).toBe("next");
    expect(
      await ipRulesLayer(() => parseAllowedNetworks("192.0.2.0/24")!, log)(
        other.request,
        other.response,
      ),
    ).toBe("next");
    expect(entries).toEqual([]);
  });
});

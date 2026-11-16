// DAN-831-2: the traffic recorder on a fake request and response, with a fake
// clock and a fake write. Real HTTP and the real log writer are in
// traffic-record.integration.test.ts. Invented values only.
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkEvent } from "../log/index.ts";
import { createTrafficRecorder, TRAFFIC_METHODS } from "./traffic-record.ts";

const REQUEST_ID = "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192";
const T0 = Date.parse("2026-11-16T09:30:00.000Z");

type FakeResponse = EventEmitter & { headersSent: boolean; statusCode: number; closed: boolean };
const fakeResponse = (): FakeResponse =>
  Object.assign(new EventEmitter(), { headersSent: true, statusCode: 204, closed: false });
const fakeRequest = (method = "GET") => ({ method }) as IncomingMessage;
const asResponse = (response: FakeResponse) => response as unknown as ServerResponse;

/** A recorder whose clock returns `times` in turn and whose writes are kept. */
function recorder(times: number[], write: (input: unknown) => unknown = () => undefined) {
  const written: Record<string, unknown>[] = [];
  const { arm } = createTrafficRecorder({
    write: async (input) => {
      written.push(input as Record<string, unknown>);
      return write(input) as never;
    },
    routeOf: () => null,
    requestIdOf: () => REQUEST_ID,
    now: () => times.shift() ?? T0,
  });
  return { arm, written };
}

const errors: unknown[] = [];
const onError = (error: unknown) => errors.push(error);
beforeAll(() => {
  process.on("unhandledRejection", onError);
  process.on("uncaughtException", onError);
});
afterAll(() => {
  process.off("unhandledRejection", onError);
  process.off("uncaughtException", onError);
});

describe("traffic recorder", () => {
  it("writes one record per response for a second arm and for an arm after close", () => {
    const { arm, written } = recorder([T0, T0 + 5]);
    const open = fakeResponse();
    arm(fakeRequest(), asResponse(open));
    arm(fakeRequest(), asResponse(open));
    open.emit("close");
    open.emit("close");
    const closed = Object.assign(fakeResponse(), { closed: true });
    arm(fakeRequest(), asResponse(closed));
    closed.emit("close");
    expect(written).toHaveLength(2);
  });

  it.each([
    ["NaN", T0, Number.NaN, 0],
    ["+Infinity", T0, Number.POSITIVE_INFINITY, 0],
    ["negative", T0, T0 - 50, 0],
    ["too long", T0, T0 + 90_000_000, 86_400_000],
    ["rounded", T0, T0 + 12.6, 13],
  ])("bounds the duration (%s) and still writes a valid time", (_name, start, end, ms) => {
    const { arm, written } = recorder([start, end]);
    const response = fakeResponse();
    arm(fakeRequest(), asResponse(response));
    response.emit("close");
    const record = written[0] as { time: string; fields: { durationMs: number } };
    expect(record.fields.durationMs).toBe(ms);
    expect(checkEvent(record, { routes: new Set() }).ok).toBe(true);
  });

  it("writes 499 when no headers were sent, whatever statusCode says", () => {
    const { arm, written } = recorder([T0, T0]);
    const response = Object.assign(fakeResponse(), { headersSent: false, statusCode: 200 });
    arm(fakeRequest("PROPFIND"), asResponse(response));
    response.emit("close");
    expect(written[0]).toMatchObject({ fields: { status: 499, method: "OTHER", ip: "none" } });
  });

  it("passes every method of its list through the catalog", () => {
    for (const method of TRAFFIC_METHODS) {
      const { arm, written } = recorder([T0, T0]);
      const response = fakeResponse();
      arm(fakeRequest(method), asResponse(response));
      response.emit("close");
      expect(checkEvent(written[0], { routes: new Set() }).ok, method).toBe(true);
    }
  });

  it("never throws for a write that throws, rejects or never settles", async () => {
    const writes = [
      () => {
        throw new Error("made-up failure");
      },
      () => Promise.reject(new Error("made-up failure")),
      () => new Promise(() => {}),
    ];
    for (const write of writes) {
      const { arm } = createTrafficRecorder({
        write: write as never,
        routeOf: () => null,
        requestIdOf: () => REQUEST_ID,
      });
      const response = fakeResponse();
      arm(fakeRequest(), asResponse(response));
      expect(() => response.emit("close")).not.toThrow();
    }
    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([]);
  });
});

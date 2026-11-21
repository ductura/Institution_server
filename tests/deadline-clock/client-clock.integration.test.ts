// SRV-1313 (plan M7.4, acceptance 4): the client's clock never reaches the
// decision on a submission. POST /api/v1/submission on a real server with the
// real pipeline, over a fake submission port: whatever time the client claims
// (a Date header from its own clock, which @ductura/test-fakes/clock sets
// forward and back around a deadline and the change to winter time, or a
// time field in the body), the port receives exactly the session, the
// document and the revision. The click itself is the database clock (app.request_submission,
// pgTAP 185). Every value is invented.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { createFakeClock } from "@ductura/test-fakes/clock";
import { afterEach, describe, expect, it } from "vitest";

import type { ActorReader } from "../../server/database/index.ts";
import {
  createDatabases,
  createLayers,
  createSubmissionRoute,
  type Running,
  startServer,
  type SubmissionOutcome,
} from "../../server/http/index.ts";

type Vector = {
  name: string;
  request: { headers: Record<string, string>; body: { documentId: string; revision: number } };
  response: { body: { receipt: unknown } };
};
const SUBMITTED = (
  JSON.parse(
    readFileSync(
      new URL("../../server/contracts/vectors/submission.submit.post.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors.find((v) => v.name === "submitted")!;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const ORIGIN = "https://ductura.example.invalid";
const PATH = "/api/v1/submission";
const TOKEN = SUBMITTED.request.headers.cookie!.slice("__Host-ductus_session=".length);

let server: Running | undefined;
const calls: unknown[][] = [];

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createSubmissionRoute({
        submit: async (...args) => {
          calls.push(args);
          return {
            status: "submitted",
            receipt: SUBMITTED.response.body.receipt,
          } as SubmissionOutcome;
        },
        actors: {} as ActorReader,
        recordActivity: async () => undefined,
        timeoutMs: 300,
      }),
    ],
  });
}
afterEach(async () => {
  calls.length = 0;
  await server?.close();
  server = undefined;
});

/** One raw request; the status of the answer. */
function post(extra: [string, string][], body: string): Promise<number> {
  const headers: [string, string][] = [
    ["host", "127.0.0.1"],
    ...Object.entries(SUBMITTED.request.headers),
    ...extra,
    ["content-length", String(Buffer.byteLength(body))],
  ];
  const head = `POST ${PATH} HTTP/1.1\r\n${headers.map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      if (text.includes("\r\n\r\n")) {
        socket.destroy();
        resolve(Number(text.split(" ")[1]));
      }
    });
    socket.on("error", reject);
    socket.write(Buffer.concat([Buffer.from(head, "latin1"), Buffer.from(body)]));
  });
}

const BODY = JSON.stringify(SUBMITTED.request.body);

describe("the client's clock never reaches the decision", () => {
  it("the client's clock, set forward and back around a deadline, never reaches the port", async () => {
    await start();
    // The client's clock: from a minute before the first 02:30 of the repeated
    // hour (00:30 UTC), forward past it, back an hour, forward two, then
    // claims far behind and ahead.
    const fake = createFakeClock("2026-10-25T00:29:00.000Z");
    let setBack = 0;
    const claim = () => new Date(fake.nowMs() - setBack).toUTCString();
    const claims: string[] = [];
    for (const step of [
      () => undefined,
      () => fake.advance(2 * MINUTE_MS),
      () => (setBack += HOUR_MS),
      () => fake.advance(2 * HOUR_MS),
    ]) {
      step();
      claims.push(claim());
    }
    claims.push("Thu, 01 Jan 1970 00:00:00 GMT", "Fri, 31 Dec 9999 23:59:59 GMT");
    expect(claims.slice(0, 4)).toEqual([
      "Sun, 25 Oct 2026 00:29:00 GMT",
      "Sun, 25 Oct 2026 00:31:00 GMT",
      "Sat, 24 Oct 2026 23:31:00 GMT",
      "Sun, 25 Oct 2026 01:31:00 GMT",
    ]);
    for (const date of claims) expect(await post([["date", date]], BODY)).toBe(200);
    expect(calls).toEqual(claims.map(() => [TOKEN, SUBMITTED.request.body]));
  });

  it.each(["requestedAt", "clientTime", "dueAt", "now", "timezone"])(
    "a body that names a time (%s) is refused before the port",
    async (field) => {
      await start();
      const body = JSON.stringify({
        ...SUBMITTED.request.body,
        [field]: "2026-10-25T00:29:00.000Z",
      });
      expect(await post([], body)).toBe(422);
      expect(calls).toEqual([]);
    },
  );
});

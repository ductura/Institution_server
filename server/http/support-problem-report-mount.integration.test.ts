// DAN-851-2d2a (contract Ductus#1836 c.6947937175): the route the entry point
// mounts, createProblemReportRouteFor(main), runs every statement on main's own
// withActor: a recorded report the RPC and then the activity touch, a refused
// report nothing, a ZD429 the RPC and no touch. A fake withActor records the
// statements; the database side is pgTAP 122 and tests/db. Values are invented.
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createProblemReportRouteFor } from "./support-problem-report.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "Izmisljeni_token-prijave-problema_000000002";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const PATH = "/api/v1/support/problem-report";
const BODY =
  '{"appVersion":"1.4.0","browser":{"family":"firefox","major":140},"category":"technical",' +
  '"description":"Izmišljeni opis: gumb ne reagira.","route":"/zadaci","syncState":"SYNCED"}';

let server: Running | undefined;
let refuseWith: string | undefined;
const seen: { token: unknown; sql: string; values: readonly unknown[] }[] = [];
let touched: () => void = () => undefined;
let touch = new Promise<void>((resolve) => (touched = resolve));

const withActor = (async (token, fn) => {
  const tx = {
    async query(sql: string, values: readonly unknown[] = []) {
      seen.push({ token, sql, values });
      if (sql.includes("submit_problem_report")) {
        if (refuseWith !== undefined)
          throw Object.assign(new Error("izmišljeno"), { code: refuseWith });
        return { rows: [{ reference: "PR-0A1B2C3D4E" }], rowCount: 1 };
      }
      touched();
      return { rows: [{ touched: true }], rowCount: 1 };
    },
  } as unknown as ActorTransaction;
  return fn(tx);
}) as WithActor;

async function start() {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [createProblemReportRouteFor({ withActor })],
  });
}
afterEach(async () => {
  seen.length = 0;
  refuseWith = undefined;
  touch = new Promise<void>((resolve) => (touched = resolve));
  await server?.close();
  server = undefined;
});

function send(headers: string[], body = BODY): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    const head = [`POST ${PATH} HTTP/1.1`, "host: 127.0.0.1", ...headers];
    head.push(`content-length: ${Buffer.byteLength(body)}`);
    socket.write(`${head.join("\r\n")}\r\n\r\n${body}`);
    let text = "";
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const [first = "", rest = ""] = text.split("\r\n\r\n");
      const length = Number(/content-length: (\d+)/i.exec(first)?.[1] ?? 0);
      if (text.includes("\r\n\r\n") && Buffer.byteLength(rest) >= length) {
        socket.destroy();
        resolve(Number(first.split(" ")[1]));
      }
    });
    socket.on("error", reject);
  });
}
const HEADERS = [`origin: ${ORIGIN}`, "sec-fetch-site: same-origin", `cookie: ${COOKIE}`];
const JSON_TYPE = "content-type: application/json";
const statements = () => seen.map((s) => s.sql.replace(/^SELECT identity\.(\w+).*$/su, "$1"));
/** Waits as long as a touch that was started needs to arrive. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("createProblemReportRouteFor(main)", () => {
  it("a refused report touches nothing", async () => {
    await start();
    expect(await send([...HEADERS.slice(0, 2), JSON_TYPE])).toBe(401);
    expect(await send([...HEADERS, "content-type: text/plain"])).toBe(415);
    expect(await send([...HEADERS, JSON_TYPE], '{"category":"technical"}')).toBe(422);
    await settle();
    expect(seen).toEqual([]);
  });

  it("a recorded report runs the RPC and then the touch, both on main's withActor", async () => {
    await start();
    expect(await send([...HEADERS, JSON_TYPE])).toBe(201);
    await touch;
    expect(statements()).toEqual(["submit_problem_report", "touch_current_session"]);
    expect(seen.map((s) => s.token)).toEqual([TOKEN, TOKEN]);
    expect(seen[0]!.values).toEqual([
      "technical",
      "Izmišljeni opis: gumb ne reagira.",
      "/zadaci",
      "1.4.0",
      "firefox",
      140,
      "SYNCED",
    ]);
  });

  it("a ZD429 runs the RPC and no touch", async () => {
    refuseWith = "ZD429";
    await start();
    expect(await send([...HEADERS, JSON_TYPE])).toBe(429);
    await settle();
    expect(statements()).toEqual(["submit_problem_report"]);
  });
});

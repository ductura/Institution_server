// DAN-851-1d2 (contract Ductus#1836 c.6939335744): the routes the entry point
// mounts, createInterfaceLocaleRoutesFor(main), run every statement on
// main's own withActor: GET one read, an accepted POST the save and then the
// activity touch, a refused POST no touch. A fake withActor records the
// statements; the database side is pgTAP 128 and tests/db. Values are invented.
import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { createInterfaceLocaleRoutesFor } from "./profile-interface-locale.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "Izmisljeni_token-jezika_sucelja_00000000002";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const PATH = "/api/v1/profile/interface-locale";

let server: Running | undefined;
const seen: { token: unknown; sql: string; values: readonly unknown[] }[] = [];

const withActor = (async (token, fn) => {
  const tx = {
    async query(sql: string, values: readonly unknown[] = []) {
      seen.push({ token, sql, values });
      if (sql.includes("set_interface_locale"))
        return { rows: [{ locale: values[0] }], rowCount: 1 };
      if (sql.includes("interface_locale()")) return { rows: [{ locale: "hr" }], rowCount: 1 };
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
    routes: createInterfaceLocaleRoutesFor({ withActor }),
  });
}
afterEach(async () => {
  seen.length = 0;
  await server?.close();
  server = undefined;
});

function send(method: string, headers: string[], body = ""): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    const head = [`${method} ${PATH} HTTP/1.1`, "host: 127.0.0.1", ...headers];
    if (body !== "") head.push(`content-length: ${Buffer.byteLength(body)}`);
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
const POST_HEADERS = [
  `origin: ${ORIGIN}`,
  "sec-fetch-site: same-origin",
  "content-type: application/json",
];
const statements = () => seen.map((s) => s.sql.replace(/^SELECT identity\.(\w+).*$/u, "$1"));

describe("createInterfaceLocaleRoutesFor(main)", () => {
  it("a refused POST touches nothing", async () => {
    await start();
    expect(await send("POST", [...POST_HEADERS, `cookie: ${COOKIE}`], '{"locale":"de"}')).toBe(422);
    expect(await send("POST", POST_HEADERS, '{"locale":"en"}')).toBe(401);
    expect(seen).toEqual([]);
  });

  it("GET is one read on main's withActor and no touch", async () => {
    await start();
    expect(await send("GET", [`cookie: ${COOKIE}`])).toBe(200);
    expect(statements()).toEqual(["interface_locale"]);
    expect(seen.map((s) => s.token)).toEqual([TOKEN]);
  });

  it("an accepted POST saves and then touches the session, both on main's withActor", async () => {
    await start();
    expect(await send("POST", [...POST_HEADERS, `cookie: ${COOKIE}`], '{"locale":"en"}')).toBe(200);
    expect(statements()).toEqual(["set_interface_locale", "touch_current_session"]);
    expect(seen.map((s) => s.token)).toEqual([TOKEN, TOKEN]);
    expect(seen[0]!.values).toEqual(["en"]);
  });
});

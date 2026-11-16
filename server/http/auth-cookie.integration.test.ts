// The attributes of the session cookie on every route that sets or clears it
// (S-1D-d, DAN-829-4): the callback over the fake OIDC provider (D-09: only
// here, under NODE_ENV=test), logout and logout-all over real HTTP. The list
// of routes is closed against server/ by N2 and ended-mark-coverage.test.ts.
// All values are invented.
import { readdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import { createOidcClient, loadAuthConfig } from "../external/srce-auth/index.ts";

import { createFakeOidc, type FakeOidcMode } from "../../packages/test-fakes/oidc/index.ts";
import { createAuthRoutes } from "./auth.ts";
import type { AuthDeps } from "./auth-flow.ts";
import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";

const NAME = "__Host-ductus_session";
const ROUTES_WITH_COOKIE = ["auth.callback.get", "auth.logout.post", "auth.logout-all.post"];
const EXPIRES = new Date("2030-01-01T12:00:00Z");
const NOW = new Date("2029-12-31T12:00:00Z");
// RFC 6265 4.1, exactly as server/session/login-cookie.ts builds it.
const SHAPE =
  /^__Host-ductus_session=([A-Za-z0-9_-]{43})?; Path=\/; HttpOnly; Secure; SameSite=Lax; (?:Expires=((?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT)|Max-Age=0)$/u;

/** Why a Set-Cookie is not a valid session cookie: a set one has a token and a later expiry, a cleared one neither. */
function defect(header: string, now: Date): string | undefined {
  const match = SHAPE.exec(header);
  if (match === null) return "shape";
  const [, token, expires] = match;
  if ((token === undefined) !== (expires === undefined)) return "set_or_clear";
  if (expires !== undefined && !(Date.parse(expires) > now.getTime())) return "expired";
  return undefined;
}

const TOKEN = "t".repeat(43);
const SET = `${NAME}=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax; Expires=${EXPIRES.toUTCString()}`;
const CLEAR = `${NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

describe("N1: the check refuses every other cookie", () => {
  it.each([
    ["no Secure", SET.replace("; Secure", "")],
    ["no HttpOnly", CLEAR.replace("; HttpOnly", "")],
    ["SameSite=None", SET.replace("Lax", "None")],
    ["SameSite=Strict", SET.replace("Lax", "Strict")],
    ["Path=/api", CLEAR.replace("Path=/", "Path=/api")],
    ["a Domain", `${SET}; Domain=ductura.invalid`],
    ["a repeated attribute", CLEAR.replace("; Secure", "; Secure; Secure")],
    ["another order", CLEAR.replace("HttpOnly; Secure", "Secure; HttpOnly")],
    ["a lower-case prefix", SET.replace("__Host-", "__host-")],
    ["a longer name", `x${SET}`],
    ["a tab", SET.replace("; Path", ";\tPath")],
    ["an NBSP", SET.replace("; Path", "; Path")],
    ["a DEL", `${SET}\u007f`],
    ["a CRLF", `${CLEAR}\r\nSet-Cookie: a=b`],
    ["a short token", SET.replace(TOKEN, "t".repeat(42))],
    ["a set cookie without Expires", `${NAME}=${TOKEN}; Path=/; HttpOnly; Secure; SameSite=Lax`],
    ["Expires and Max-Age", `${SET}; Max-Age=0`],
    ["a cleared cookie with a value", CLEAR.replace("=;", `=${TOKEN};`)],
    ["a cleared cookie with Max-Age=1", CLEAR.replace("=0", "=1")],
    ["a cleared cookie with Expires", SET.replace(TOKEN, "")],
    ["an expiry in the past", SET.replace("2030", "2020")],
  ])("%s", (_name, header) => {
    expect(defect(header, NOW)).toBeDefined();
  });

  it("accepts what login-cookie.ts builds", () => {
    expect([defect(SET, NOW), defect(CLEAR, NOW)]).toEqual([undefined, undefined]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name).replaceAll("\\", "/");
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

describe("N2: the list of routes is closed", () => {
  const files = sourceFiles("server").map((file) => [file, readFileSync(file, "utf8")] as const);

  it("only login-cookie.ts builds the cookie, and only auth-flow.ts calls it", () => {
    const builds = files.filter(
      ([file, text]) =>
        file.startsWith("server/session/") && /\$\{SESSION_COOKIE_NAME\}=/u.test(text),
    );
    expect(builds.map(([file]) => file)).toEqual(["server/session/login-cookie.ts"]);
    const callers = files.filter(([, text]) =>
      /\b(?:sessionSetCookie|clearedSessionSetCookie)\(/u.test(text),
    );
    expect(callers.map(([file]) => file).sort()).toEqual([
      "server/http/auth-flow.ts",
      "server/session/login-cookie.ts",
    ]);
  });

  it("the contract vectors set it on these routes alone", () => {
    const dir = "server/contracts/vectors";
    type Vectors = {
      route: string;
      vectors: { response: { headers?: { "set-cookie"?: string[] } } }[];
    };
    const routes = readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Vectors)
      .filter(({ vectors }) =>
        vectors.some((v) =>
          v.response.headers?.["set-cookie"]?.some((c) => c.startsWith(`${NAME}=`)),
        ),
      )
      .map(({ route }) => route);
    expect(routes.sort()).toEqual([...ROUTES_WITH_COOKIE].sort());
    expect(ROUTES_WITH_COOKIE.filter((id) => !ROUTES.some((r) => r.id === id))).toEqual([]);
  });
});

let app: Running | undefined;
let provider: Server | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  await app?.close();
  if (provider) await new Promise<void>((done) => provider?.close(() => done()));
  app = provider = undefined;
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", done));
  const { port } = probe.address() as AddressInfo;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function stack(mode: FakeOidcMode, failing: "close" | null = null) {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  // The fake provider takes loopback callbacks alone, so the origin is known before the server starts.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const server = createServer();
  provider = server;
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const fake = createFakeOidc({
    issuer,
    redirectUris: [`${origin}/api/v1/auth/callback`],
    postLogoutRedirectUris: [`${origin}/`],
    backchannelLogoutUri: `${origin}/api/v1/auth/backchannel-logout`,
    mode,
  });
  server.on("request", (req, res) => fake.emit("request", req, res));
  const env = {
    NODE_ENV: "test",
    DUCTUS_AUTH_PROVIDER: "fake-oidc",
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: "ductus-local",
    OIDC_CLIENT_SECRET: "ductus-local-only",
    OIDC_REDIRECT_URI: `${origin}/api/v1/auth/callback`,
  };
  const fail = () => Promise.reject(new Error("database down"));
  const load = (): AuthDeps => {
    const config = loadAuthConfig(env);
    return {
      config,
      oidc: createOidcClient(config),
      openSession: async () => ({ ok: true, expires: EXPIRES }),
      closeSession: failing === "close" ? fail : async () => true,
      closeAllSessions: failing === "close" ? fail : async () => undefined,
    };
  };
  app = await startServer({
    host: "127.0.0.1",
    port,
    layers: createLayers({ expectedOrigin: origin }),
    databases: createDatabases(),
    routes: createAuthRoutes(env, load),
  });
  const jar = new Map<string, string>();
  /** A browser with one cookie jar and manual redirects. */
  const go = async (url: string, method = "GET", form?: Record<string, string>) => {
    const answer = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        cookie: [...jar].map(([n, v]) => `${n}=${v}`).join("; "),
        ...(method === "POST" ? { origin } : {}),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    for (const c of answer.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const at = pair.indexOf("=");
      if (c.includes("Max-Age=0")) jar.delete(pair.slice(0, at));
      else jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return answer;
  };
  const next = (answer: Response, base: string) =>
    new URL(answer.headers.get("location")!, base).href;
  const signIn = async () => {
    const authorize = next(await go(`${origin}/api/v1/auth/login`), origin);
    const interaction = next(await go(authorize), authorize);
    const resume = next(
      await go(`${interaction}/login`, "POST", { account: "demo-student" }),
      interaction,
    );
    return go(next(await go(resume), resume));
  };
  return { go, signIn, origin };
}

const sessionCookies = (answer: Response) =>
  answer.headers.getSetCookie().filter((c) => c.startsWith(`${NAME}=`));

describe("N3: a refused request leaves the session cookie alone", () => {
  it("callback refused by the provider", async () => {
    const { signIn } = await stack("refuse");
    const answer = await signIn();
    expect(answer.status).toBe(400);
    expect(sessionCookies(answer)).toEqual([]);
  });

  it("logout-all when the database fails: 503, the cookie kept", async () => {
    const { go, signIn, origin } = await stack("success", "close");
    await signIn();
    const answer = await go(`${origin}/api/v1/auth/logout-all`, "POST");
    expect(answer.status).toBe(503);
    expect(sessionCookies(answer)).toEqual([]);
  });
});

describe("P: every route that sets or clears the cookie sends exactly one valid cookie", () => {
  it.each([
    ["auth.logout.post", "/api/v1/auth/logout", null],
    ["auth.logout.post", "/api/v1/auth/logout", "close"],
    ["auth.logout-all.post", "/api/v1/auth/logout-all", null],
  ] as const)("auth.callback.get, then %s at %s (failing: %s)", async (_id, path, failing) => {
    const { go, signIn, origin } = await stack("success", failing);
    const login = sessionCookies(await signIn());
    expect(login).toHaveLength(1);
    expect(defect(login[0]!, NOW)).toBeUndefined();
    expect(login[0]).toContain(`Expires=${EXPIRES.toUTCString()}`);
    const out = await go(`${origin}${path}`, "POST");
    expect(out.status).toBe(303);
    expect(sessionCookies(out)).toEqual([CLEAR]);
  });
});

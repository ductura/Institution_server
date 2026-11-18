// The real process of dist/server.js (S-1B-a, DAN-775): built with the same
// function as `pnpm build` into a temporary folder and started there, away
// from node_modules, so the one file is all it needs. A minimal environment of
// invented values; stopped with SIGTERM. No Docker: the database host is
// .invalid and nothing may connect to it at startup.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildServer, SERVER_NODE_FLAGS } from "../scripts/build/index.ts";

import { SERVER_VERSION } from "./config/index.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CANARY = "invented-canary-7f3a";
const DATABASE_URL = `postgres://app:${CANARY}@db.invalid:5432/ductura`;
const VECTOR = JSON.parse(
  readFileSync(join(ROOT, "server/contracts/vectors/platform.health.get.json"), "utf8"),
) as {
  vectors: { name: string; response: { status: number; contentType: string; body: unknown } }[];
};

type Started = {
  child: ChildProcess;
  stdout: string[];
  stderr: string[];
  exit: Promise<number | null>;
};

let dir: string | undefined;
let outfile: string;
const children: ChildProcess[] = [];

function run(env: Record<string, string>): Started {
  // No inherited variables: only what the case names (and PATH for node).
  const child = spawn(process.execPath, [...SERVER_NODE_FLAGS, outfile], {
    cwd: dir,
    env: { PATH: process.env.PATH ?? "", OIDC_CLIENT_SECRET: CANARY, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => stdout.push(String(chunk)));
  child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  const exit = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
  return { child, stdout, stderr, exit };
}

async function listening(started: Started): Promise<number> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const line = started.stdout
      .join("")
      .split("\n")
      .find((l) => l.includes("server.listening"));
    if (line !== undefined) return (JSON.parse(line) as { port: number }).port;
    if (started.child.exitCode !== null) throw new Error(`exited: ${started.stderr.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("server did not start");
}

const start = async (env: Record<string, string> = {}): Promise<[Started, number]> => {
  const started = run({ PORT: "0", APP_DATABASE_URL: DATABASE_URL, ...env });
  return [started, await listening(started)];
};
const url = (port: number, path: string): string => `http://127.0.0.1:${port}${path}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "ductura-server-"));
  outfile = join(dir, "server.js");
  await buildServer(ROOT, outfile);
}, 60_000);

afterAll(() => {
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  // A failed build must surface as itself, not as a TypeError here.
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

/** The problem body of a contract error (S-1L.3); the request id is new each time. */
const problem = (status: number, code: string, messageKey: string) => ({
  error: code,
  code,
  messageKey,
  status,
  requestId: expect.stringMatching(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  ),
});

describe("dist/server.js", () => {
  it("answers health as its contract vector, says nothing else and stops on SIGTERM", async () => {
    const [server, port] = await start();
    const response = await fetch(url(port, "/api/v1/health"), {
      headers: { cookie: "__Host-session=invented", authorization: "Bearer invented" },
    });
    // The main database is .invalid, so the answer is the `degraded` vector
    // (S-1M-a), with this build's own version in place of the vector's.
    const degraded = VECTOR.vectors.find((v) => v.name === "degraded");
    expect(response.status).toBe(degraded?.response.status);
    expect(response.headers.get("content-type")).toMatch(/^application\/json(;|$)/u);
    expect(await response.json()).toEqual({
      ...(degraded?.response.body as object),
      serverVersion: SERVER_VERSION,
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    // Only transport headers and the security headers of step 6 (S-1B-b)
    // besides the two above: no server, version or host.
    const ALLOWED = [
      "content-security-policy",
      "permissions-policy",
      "referrer-policy",
      "strict-transport-security",
      "x-content-type-options",
      "x-frame-options",
      "cache-control",
      "connection",
      "content-length",
      "content-type",
      "date",
      "keep-alive",
      "transfer-encoding",
    ];
    expect([...response.headers.keys()].filter((name) => !ALLOWED.includes(name))).toEqual([]);

    server.child.kill("SIGTERM");
    await server.exit;
    await expect(fetch(url(port, "/api/v1/health"))).rejects.toThrow();
    const output = server.stdout.join("") + server.stderr.join("");
    expect(output).not.toContain(CANARY);
    expect(server.stderr.join("")).toBe("");
  }, 20_000);

  it("refuses an unknown path, another method and a trailing slash in the contract format", async () => {
    const [server, port] = await start({ APP_ORIGIN: "https://ductura.invalid" });
    const unknown = await fetch(url(port, "/api/v1/nope?x=1"));
    expect([unknown.status, await unknown.json()]).toEqual([
      404,
      problem(404, "not_found", "errors.notFound"),
    ]);
    const slash = await fetch(url(port, "/api/v1/health/"));
    expect(slash.status).toBe(404);
    // Step 7 (S-1B-b) comes before the router: a POST without our Origin never reaches it.
    const foreign = await fetch(url(port, "/api/v1/health"), { method: "POST" });
    // 403 is a oneOf discriminated by the code: the full problem body (DAN-791).
    expect([foreign.status, await foreign.json()]).toEqual([
      403,
      problem(403, "origin_missing", "errors.originMissing"),
    ]);
    const post = await fetch(url(port, "/api/v1/health"), {
      method: "POST",
      headers: { origin: "https://ductura.invalid" },
    });
    expect([post.status, post.headers.get("allow"), await post.json()]).toEqual([
      405,
      "GET",
      problem(405, "method_not_allowed", "errors.methodNotAllowed"),
    ]);
    const head = await fetch(url(port, "/api/v1/health"), { method: "HEAD" });
    expect(head.status).toBe(405);
    server.child.kill("SIGTERM");
    await server.exit;
  }, 20_000);

  it.each([
    ["no APP_DATABASE_URL", { APP_DATABASE_URL: "" }, "APP_DATABASE_URL is not set"],
    [
      "a foreign URL",
      { APP_DATABASE_URL: `mysql://u:${CANARY}@db.invalid/x` },
      "APP_DATABASE_URL is not a postgres URL",
    ],
    ["a word as PORT", { PORT: `abc${CANARY}` }, "PORT is not a port number"],
    ["a PORT above 65535", { PORT: "70000" }, "PORT is not a port number"],
    ["an empty HOST", { HOST: "" }, "HOST is empty or has spaces"],
    [
      "an APP_ORIGIN with a path",
      { APP_ORIGIN: `https://${CANARY}.invalid/x` },
      "APP_ORIGIN is not a bare http(s) origin",
    ],
    // S-1H.7 (DAN-938-1): the test mode never starts in production, and an
    // unknown mode never starts at all.
    [
      "DUCTURA_MODE test and NODE_ENV unset",
      { DUCTURA_MODE: "test" },
      "DUCTURA_MODE test is refused in production",
    ],
    [
      "DUCTURA_MODE test and NODE_ENV production",
      { DUCTURA_MODE: "test", NODE_ENV: "production" },
      "DUCTURA_MODE test is refused in production",
    ],
    [
      "DUCTURA_MODE test and NODE_ENV empty",
      { DUCTURA_MODE: "test", NODE_ENV: "" },
      "DUCTURA_MODE test is refused in production",
    ],
    [
      "DUCTURA_MODE test and NODE_ENV Test",
      { DUCTURA_MODE: "test", NODE_ENV: "Test" },
      "DUCTURA_MODE test is refused in production",
    ],
    [
      "DUCTURA_MODE test and NODE_ENV test and a line feed",
      { DUCTURA_MODE: "test", NODE_ENV: "test\n" },
      "DUCTURA_MODE test is refused in production",
    ],
    [
      "an unknown DUCTURA_MODE under NODE_ENV test",
      { NODE_ENV: "test", DUCTURA_MODE: `test${CANARY}` },
      "DUCTURA_MODE is not a known mode",
    ],
  ])(
    "does not start with %s and names the variable, never the value",
    async (_, env, problem) => {
      const started = run({ PORT: "0", APP_DATABASE_URL: DATABASE_URL, ...env });
      expect(await started.exit).toBe(1);
      const stderr = started.stderr.join("");
      expect(stderr).toContain(`startup refused: ${problem}`);
      expect(stderr + started.stdout.join("")).not.toContain(CANARY);
      expect(started.stdout.join("")).not.toContain("server.listening");
    },
    20_000,
  );

  // S-1H.7 (DAN-938-1): the control of the cases above. The same mode under
  // NODE_ENV test starts and answers, so a refusal there is the guard's.
  it("starts with DUCTURA_MODE test under NODE_ENV test", async () => {
    const [server, port] = await start({ DUCTURA_MODE: "test", NODE_ENV: "test" });
    expect((await fetch(url(port, "/api/v1/health"))).status).toBe(200);
    server.child.kill("SIGTERM");
    await server.exit;
    expect(server.stderr.join("")).not.toContain("startup refused");
  }, 20_000);

  // S-1E-a (DAN-808), D-09: the entry point mounts the login routes over its
  // own process environment. A server started with the fake provider and
  // NODE_ENV production, or without NODE_ENV, refuses sign-in with a 303 to
  // /prijava?greska=provider_unavailable (DAN-1081): no attempt cookie, no
  // variable name, no secret, in the answer
  // or in its output. Nothing here listens at the issuer: the refusal comes
  // from the configuration, before any request to a provider.
  it.each([["production"], [undefined]])(
    "D-09: mounts the login routes and refuses the fake provider with NODE_ENV %s",
    async (nodeEnv) => {
      const [server, port] = await start({
        ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
        DUCTUS_AUTH_PROVIDER: "fake-oidc",
        OIDC_ISSUER: "http://127.0.0.1:9",
        OIDC_CLIENT_ID: "ductus-local",
        OIDC_REDIRECT_URI: "http://127.0.0.1:4000/api/v1/auth/callback",
      });
      // DAN-1081: the sign-in page with provider_unavailable, never the issuer;
      // the callback clears an attempt the browser still has, the login sets nothing.
      const attempt = "__Host-ductus_login";
      const cleared = `${attempt}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
      for (const [path, cookies] of [
        ["/api/v1/auth/login", []],
        ["/api/v1/auth/callback?code=x&state=y", [cleared]],
      ] as const) {
        const response = await fetch(url(port, path), {
          redirect: "manual",
          headers: { cookie: `${attempt}=${"a".repeat(64)}` },
        });
        expect(response.status, path).toBe(303);
        expect(response.headers.get("location")).toBe("/prijava?greska=provider_unavailable");
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.getSetCookie(), path).toEqual(cookies);
        const body = await response.text();
        expect(body).toBe("");
        const headers = JSON.stringify([...response.headers]);
        expect(headers).not.toMatch(/NODE_ENV|DUCTUS_AUTH_PROVIDER|OIDC_|fake|127\.0\.0\.1/u);
        expect(headers).not.toContain(CANARY);
      }
      server.child.kill("SIGTERM");
      await server.exit;
      const output = server.stdout.join("") + server.stderr.join("");
      expect(output).not.toContain(CANARY);
      expect(output).not.toMatch(/OIDC_|DUCTUS_AUTH_PROVIDER/u);
      expect(server.stderr.join("")).toBe(
        "login failed config AuthConfigError provider_unavailable\n".repeat(2),
      );
    },
    20_000,
  );

  it("a second process on a taken port exits 1 and the first keeps answering", async () => {
    const [first, port] = await start();
    const second = run({ PORT: String(port), APP_DATABASE_URL: DATABASE_URL });
    expect(await second.exit).toBe(1);
    expect(second.stderr.join("")).toBe("listen failed: EADDRINUSE\n");
    expect((await fetch(url(port, "/api/v1/health"))).status).toBe(200);
    first.child.kill("SIGTERM");
    await first.exit;
  }, 20_000);
});

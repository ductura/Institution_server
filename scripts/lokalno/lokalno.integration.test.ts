// `pnpm lokalno` end to end without PostgreSQL (Ductus#2028, task item 5): the
// fake OIDC provider runs as its own process with exactly the variables
// oidcEnv gives it, the server's login routes run with exactly the variables
// serverEnv gives the server, and a browser goes login → simulator → callback
// → session cookie. Only openSession is in memory; the real database path is
// what `pnpm lokalno` adds (docs/LOKALNO.md, "Provjera"). All accounts and
// domains are invented (D-09: the provider runs here under NODE_ENV
// development, started by this test).
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { OpenSessionInput } from "../../server/database/index.ts";
import { createOidcClient, loadAuthConfig } from "../../server/external/srce-auth/index.ts";
import {
  type AuthDeps,
  createAuthRoutes,
  createDatabases,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";
import { SESSION_COOKIE_NAME } from "../../server/session/index.ts";
import { baseEnv, oidcEnv, serverEnv, type StackOptions } from "./config.ts";
import { signIn as signInForSeed } from "./seed-predaja.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const EXPIRES = new Date("2030-01-01T12:00:00Z");
const SECRETS = {
  appPassword: "a".repeat(40),
  authPassword: "b".repeat(40),
  provisioningToken: "c".repeat(43),
};

let provider: ChildProcess | undefined;
let app: Running | undefined;
let dir: string | undefined;
afterEach(async () => {
  await app?.close();
  if (provider !== undefined && provider.exitCode === null) {
    const ended = new Promise((done) => provider?.once("exit", done));
    provider.kill();
    await ended;
  }
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  app = undefined;
  provider = undefined;
  dir = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(url: string, child: ChildProcess): Promise<void> {
  for (const end = Date.now() + 20_000; Date.now() < end;) {
    if (child.exitCode !== null) throw new Error("the provider ended");
    try {
      const answer = await fetch(url);
      await answer.body?.cancel();
      if (answer.status === 200) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the provider did not answer");
}

/** The provider as `pnpm lokalno` starts it, and the server's login routes with its variables. */
async function stack(
  accounts?: object,
): Promise<{ origin: string; issuer: string; opened: OpenSessionInput[] }> {
  const [serverPort, oidcPort] = [await freePort(), await freePort()];
  const origin = `http://localhost:${serverPort}`;
  let accountsFile: string | undefined;
  if (accounts !== undefined) {
    dir = mkdtempSync(join(tmpdir(), "lokalno-"));
    accountsFile = join(dir, "oidc-racuni.json");
    writeFileSync(accountsFile, JSON.stringify(accounts));
  }
  const options: StackOptions = {
    origin,
    serverPort,
    oidcPort,
    issuer: `http://localhost:${oidcPort}`,
    ...(accountsFile === undefined ? {} : { accountsFile }),
  };
  provider = spawn(process.execPath, [join(ROOT, "packages/test-fakes/oidc/server.ts")], {
    cwd: ROOT,
    env: { ...baseEnv(process.env), ...oidcEnv(options) },
    stdio: "ignore",
  });
  await waitFor(`http://127.0.0.1:${oidcPort}/.well-known/openid-configuration`, provider);

  const env = serverEnv(options, { host: "127.0.0.1", port: "5432" }, SECRETS);
  const opened: OpenSessionInput[] = [];
  const load = (): AuthDeps => {
    const config = loadAuthConfig(env);
    return {
      config,
      oidc: createOidcClient(config),
      openSession: async (input) => {
        opened.push(input);
        return { ok: true, expires: EXPIRES };
      },
      closeSession: async () => true,
      closeAllSessions: async () => undefined,
    };
  };
  app = await startServer({
    host: "127.0.0.1",
    port: serverPort,
    layers: createLayers({ expectedOrigin: env.APP_ORIGIN ?? null }),
    databases: createDatabases(),
    routes: createAuthRoutes(env, load),
  });
  return { origin, issuer: options.issuer, opened };
}

/** A browser reduced to one cookie jar and manual redirects. */
function browser() {
  const jar = new Map<string, string>();
  const go = async (url: string, form?: Record<string, string>) => {
    const response = await fetch(url, {
      method: form === undefined ? "GET" : "POST",
      redirect: "manual",
      headers: {
        cookie: [...jar].map(([name, value]) => `${name}=${value}`).join("; "),
        ...(form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" }),
      },
      ...(form === undefined ? {} : { body: new URLSearchParams(form).toString() }),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair = ""] = cookie.split(";");
      const at = pair.indexOf("=");
      if (/Max-Age=0/u.test(cookie)) jar.delete(pair.slice(0, at));
      else jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    return response;
  };
  return go;
}

const next = (response: Response, base: string): string => {
  const target = response.headers.get("location");
  if (target === null) throw new Error(`no redirect (${response.status})`);
  return new URL(target, base).href;
};

/** Login, the simulator's page and `form`, and back to the callback: its answer and the page. */
async function signIn(origin: string, form: Record<string, string>) {
  const go = browser();
  const start = await go(`${origin}/api/v1/auth/login?returnTo=/aplikacija/`);
  expect(start.status).toBe(303);
  const authorize = next(start, origin);
  const interaction = next(await go(authorize), authorize);
  const page = await (await go(interaction)).text();
  const posted = await go(`${interaction}/login`, form);
  if (posted.status !== 303) return { answer: posted, page };
  const resume = next(posted, interaction);
  const back = next(await go(resume), resume);
  expect(back.startsWith(`${origin}/api/v1/auth/callback?`)).toBe(true);
  return { answer: await go(back), page };
}

function expectSession(answer: Response, origin: string): void {
  expect(answer.status).toBe(303);
  expect(answer.headers.get("location")).toBe(`${origin}/aplikacija/`);
  const session = answer.headers
    .getSetCookie()
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  expect(session).toMatch(/; Path=\/; HttpOnly; Secure; SameSite=Lax; Expires=/u);
}

describe("pnpm lokalno: login through the AAI@EduHr simulator", () => {
  it("the submission seeder signs in with a committed fake account", async () => {
    const accounts = JSON.parse(
      readFileSync(join(ROOT, "db/main/local/lazni-oidc-racuni.json"), "utf8"),
    ) as object;
    const { origin, issuer, opened } = await stack(accounts);
    const subject = "sim:student:demo-student-3@demo.ductus.test";
    const api = await signInForSeed(origin, issuer, subject);
    expect(opened).toEqual([expect.objectContaining({ subject, teacherEligible: false })]);
    const logout = await api("auth/logout", {});
    expect(logout.status).toBe(303);
    await logout.body?.cancel();
  }, 30_000);

  it("a typed domain and role sign in as an account of that institution", async () => {
    const { origin, issuer, opened } = await stack();
    const { answer, page } = await signIn(origin, {
      domena: "Nova-Ustanova.test",
      uloga: "nastavnik",
      korisnik: "",
    });
    expect(page).toContain("Račun bilo koje ustanove");
    expectSession(answer, origin);
    expect(opened).toEqual([
      expect.objectContaining({
        issuer,
        subject: "sim:nastavnik:nastavnik@nova-ustanova.test",
        uniqueId: "nastavnik@nova-ustanova.test",
        homeOrg: "nova-ustanova.test",
        givenName: "Simulirani",
        familyName: "Nastavnik",
        teacherEligible: true,
      }),
    ]);
  }, 30_000);

  it("a named account of .local/oidc-racuni.json is a button and signs in with its names", async () => {
    const { origin, opened } = await stack({
      racuni: [
        { korisnik: "iva.p", domena: "druga.test", uloga: "student", ime: "Iva", prezime: "Perić" },
      ],
    });
    const { answer, page } = await signIn(origin, { account: "sim:student:iva.p@druga.test" });
    expect(page).toContain("Iva Perić (druga.test, student)");
    expectSession(answer, origin);
    expect(opened).toEqual([
      expect.objectContaining({
        subject: "sim:student:iva.p@druga.test",
        homeOrg: "druga.test",
        givenName: "Iva",
        familyName: "Perić",
        teacherEligible: false,
      }),
    ]);
  }, 30_000);

  it("a domain that is not one, or an unknown role, gets no account and no session", async () => {
    const { origin, opened } = await stack();
    for (const form of [
      { domena: "localhost", uloga: "student" },
      { domena: "x.test", uloga: "admin" },
      { domena: "x.test", uloga: "student", korisnik: "a b" },
    ]) {
      const { answer } = await signIn(origin, form);
      expect(answer.status).toBe(400);
    }
    expect(opened).toEqual([]);
  }, 30_000);
});

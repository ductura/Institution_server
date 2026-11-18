// The login routes over plain HTTP (S-1E-a, DAN-808): the composer of the
// login dependencies and the wrapper of server/session's Request to Response
// flow, in place of Ductus src/server/auth/deps.ts and app/api/auth/{login,
// callback}/route.ts at 078c780. Method and path come from the contract.
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ErrorSpec, ROUTES, type RouteContract } from "../contracts/index.ts";
import {
  backchannelLogout as closeNamedSessions,
  openSession,
  withActor,
} from "../database/index.ts";
import {
  createCachedKeySource,
  createLogoutVerifier,
  createOidcClient,
  loadAuthConfig,
} from "../external/srce-auth/index.ts";
import {
  backchannelLogout,
  type BackchannelDeps,
  MAX_BACKCHANNEL_BODY_BYTES,
} from "../session/index.ts";

import {
  type AuthDeps,
  failedLogin,
  failurePage,
  finishLogin,
  logout,
  logoutAll,
  startLogin,
} from "./auth-flow.ts";
import { readBodyWithLimit } from "./mutation-request.ts";
import { sendBareRefusal, sendHtmlProblem } from "./problem.ts";
import type { Route } from "./router.ts";

type Flow = (request: Request, deps: AuthDeps) => Promise<Response>;

/** The routes whose failures go to the sign-in page (DAN-1081); sign-out keeps its pages. */
const LOGIN_IDS: ReadonlySet<string> = new Set(["auth.login.get", "auth.callback.get"]);

function contractOf(id: string): RouteContract {
  const found = ROUTES.find((route) => route.id === id);
  if (found === undefined) throw new Error(`no contract ${id}`);
  return found;
}

/**
 * The real dependencies, built on the first login request rather than at
 * start, so a server without a login setup still starts and answers health
 * (server/config/environment.ts). An invalid configuration (the fake
 * provider without a development or test NODE_ENV among them, D-09) throws
 * here, on every login. NODE_ENV is read from the environment the entry point
 * hands in (its process.env): a server
 * started without it counts as production (server/external/srce-auth).
 */
export function loadAuthDeps(env: Readonly<Record<string, string | undefined>>): AuthDeps {
  const config = loadAuthConfig({ ...env, NODE_ENV: env.NODE_ENV });
  return {
    config,
    oidc: createOidcClient(config),
    openSession,
    closeSession: (token) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<{ closed: boolean }>(
          "SELECT identity.close_current_session() AS closed",
        );
        return rows[0]?.closed === true;
      }),
    closeAllSessions: (token) =>
      withActor(token, async (tx) => {
        await tx.query("SELECT identity.close_all_sessions_for_identity()");
      }),
  };
}

/**
 * The request the flow reads: the contract's method, the path and query of
 * this request on the configured origin (never the Host header), its cookies
 * and its Origin and Sec-Fetch-Site, nothing else. The body is never read.
 */
function webRequest(request: IncomingMessage, origin: string, method: string): Request {
  const headers = new Headers();
  for (const name of ["cookie", "origin", "sec-fetch-site"]) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request(new URL(request.url ?? "/", origin), { method, headers });
}

async function writeResponse(
  answer: Response,
  response: ServerResponse,
  contract: RouteContract,
): Promise<void> {
  const setCookies = answer.headers.getSetCookie();
  if (answer.status < 400) {
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of answer.headers) if (name !== "set-cookie") headers[name] = value;
    if (setCookies.length > 0) headers["set-cookie"] = setCookies;
    response.writeHead(answer.status, headers);
    response.end();
    return;
  }
  const spec: ErrorSpec | undefined = contract.errors.find(
    (error) => error.status === answer.status && error.body === "html",
  );
  // An unknown status is a programming error: sendHtmlProblem answers 500.
  sendHtmlProblem(
    response,
    spec ?? { status: answer.status, code: "", key: "" },
    await answer.text(),
    setCookies,
  );
}

function route(id: string, flow: Flow, load: () => AuthDeps): Route {
  const contract = contractOf(id);
  return {
    contract,
    handle: async (request, response) => {
      let deps: AuthDeps;
      try {
        deps = load();
      } catch (error) {
        // The class only: a configuration error names a variable, and the
        // answer must not (D-09, a fake provider in production included).
        // Without a configuration there is no origin: the Location is relative.
        // Sign-out keeps its 503 page (Ductus#2031 R3).
        const name = error instanceof Error ? error.name : "unknown";
        if (LOGIN_IDS.has(id)) {
          await writeResponse(
            failedLogin("config", name, "provider_unavailable"),
            response,
            contract,
          );
        } else {
          console.error("login failed", "config", name);
          await writeResponse(failurePage(503), response, contract);
        }
        return;
      }
      const origin = deps.config.redirectUri.origin;
      const answer = await flow(webRequest(request, origin, contract.method), deps);
      await writeResponse(answer, response, contract);
    },
  };
}

/**
 * The back-channel dependencies (S-1D-d, DAN-829-3; Ductus
 * backchannel-route.ts): the login configuration, one JWKS cache per set of
 * routes (an unknown kid refreshes the keys at most once a minute) and the
 * database port that only closes sessions, never opens one (F-042). A set
 * that fails to load is tried again on the next request. `ports` replaces
 * the provider fetch and the database port in tests only.
 */
export function loadBackchannelDeps(
  env: Readonly<Record<string, string | undefined>>,
  ports: { fetch?: typeof fetch; backchannelLogout?: BackchannelDeps["backchannelLogout"] } = {},
): BackchannelDeps {
  const config = loadAuthConfig({ ...env, NODE_ENV: env.NODE_ENV });
  const provider = createOidcClient(config, ports.fetch);
  return {
    verifier: createLogoutVerifier({
      config,
      discoveredIssuer: () => provider.discoveredIssuer(),
      keys: createCachedKeySource({ load: () => provider.jwks() }),
    }),
    backchannelLogout: ports.backchannelLogout ?? closeNamedSessions,
  };
}

/**
 * The core's answer, which never has a body: 200 as it is, 400 and 503
 * through the contract's bare refusal (the router lets errors out only so).
 */
function writeBare(response: ServerResponse, contract: RouteContract, answer: Response): void {
  if (answer.status >= 400) {
    sendBareRefusal(response, contract, answer.status);
    return;
  }
  const headers: Record<string, string> = {};
  for (const [name, value] of answer.headers) headers[name] = value;
  response.writeHead(answer.status, headers);
  response.end();
}

/**
 * POST /api/v1/auth/backchannel-logout. The body is read to the contract's
 * limit and handed to server/session as a form; a body refused before that
 * is 400 (the contract's only refusal of a request) and closes the
 * connection. Only the content type crosses over, never a cookie or Origin.
 */
function backchannelRoute(load: () => BackchannelDeps): Route {
  const contract = contractOf("auth.backchannel-logout.post");
  return {
    contract,
    handle: async (request, response) => {
      let deps: BackchannelDeps;
      try {
        deps = load();
      } catch (error) {
        console.error(
          "backchannel logout failed",
          "config",
          error instanceof Error ? error.name : "unknown",
        );
        sendBareRefusal(response, contract, 503);
        return;
      }
      const body = await readBodyWithLimit(request, MAX_BACKCHANNEL_BODY_BYTES);
      if (!body.ok) {
        console.error("backchannel logout failed", "request", body.reason);
        response.setHeader("Connection", "close");
        sendBareRefusal(response, contract, 400);
        return;
      }
      const type = request.headers["content-type"];
      const web = new Request(new URL(contract.path, "http://backchannel.invalid"), {
        method: "POST",
        headers: typeof type === "string" ? { "content-type": type } : {},
        body: body.bytes,
      });
      writeBare(response, contract, await backchannelLogout(web, deps));
    },
  };
}

/**
 * GET /api/v1/auth/login, GET /api/v1/auth/callback, POST /api/v1/auth/logout,
 * POST /api/v1/auth/logout-all and POST /api/v1/auth/backchannel-logout.
 */
export function createAuthRoutes(
  env: Readonly<Record<string, string | undefined>>,
  load: () => AuthDeps = () => loadAuthDeps(env),
  loadBackchannel: () => BackchannelDeps = () => loadBackchannelDeps(env),
): Route[] {
  // One set for all routes, kept once it loads; a failed load is tried again
  // on the next login, as in Ductus deps.ts.
  let deps: AuthDeps | undefined;
  const shared = (): AuthDeps => (deps ??= load());
  let backchannel: BackchannelDeps | undefined;
  return [
    route("auth.login.get", startLogin, shared),
    route("auth.callback.get", finishLogin, shared),
    route("auth.logout.post", logout, shared),
    route("auth.logout-all.post", logoutAll, shared),
    backchannelRoute(() => (backchannel ??= loadBackchannel())),
  ];
}

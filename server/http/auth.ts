// The login routes over plain HTTP (S-1E-a, DAN-808): the composer of the
// login dependencies and the wrapper of server/session's Request to Response
// flow, in place of Ductus src/server/auth/deps.ts and app/api/auth/{login,
// callback}/route.ts at 078c780. Method and path come from the contract.
import type { IncomingMessage, ServerResponse } from "node:http";

import { type ErrorSpec, ROUTES, type RouteContract } from "../contracts/index.ts";
import { openSession, withActor } from "../database/index.ts";
import { createOidcClient, loadAuthConfig } from "../external/srce-auth/index.ts";

import { type AuthDeps, failurePage, finishLogin, startLogin } from "./auth-flow.ts";
import { sendHtmlProblem } from "./problem.ts";
import type { Route } from "./router.ts";

type Flow = (request: Request, deps: AuthDeps) => Promise<Response>;

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
  };
}

/**
 * The request the flow reads: the path and query of this request on the
 * configured origin (never the Host header) and its cookies, nothing else.
 */
function webRequest(request: IncomingMessage, origin: string): Request {
  const headers = new Headers();
  const cookie = request.headers.cookie;
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request(new URL(request.url ?? "/", origin), { method: "GET", headers });
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
        // page must not (D-09, a fake provider in production included).
        console.error("login failed", "config", error instanceof Error ? error.name : "unknown");
        await writeResponse(failurePage(503), response, contract);
        return;
      }
      const answer = await flow(webRequest(request, deps.config.redirectUri.origin), deps);
      await writeResponse(answer, response, contract);
    },
  };
}

/** GET /api/v1/auth/login and GET /api/v1/auth/callback. */
export function createAuthRoutes(
  env: Readonly<Record<string, string | undefined>>,
  load: () => AuthDeps = () => loadAuthDeps(env),
): Route[] {
  // One set for both routes, kept once it loads; a failed load is tried again
  // on the next login, as in Ductus deps.ts.
  let deps: AuthDeps | undefined;
  const shared = (): AuthDeps => (deps ??= load());
  return [
    route("auth.login.get", startLogin, shared),
    route("auth.callback.get", finishLogin, shared),
  ];
}

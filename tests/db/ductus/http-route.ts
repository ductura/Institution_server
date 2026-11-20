import {
  createDatabases,
  createLayers,
  startServer,
  type Route,
  type Running,
} from "../../../server/http/index.ts";
import { SESSION_COOKIE_NAME } from "../../../server/session/session-token.ts";

export function startTestRoute(route: Route, origin: string): Promise<Running> {
  return startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: origin }),
    databases: createDatabases(),
    routes: [route],
  });
}

export function postTestRoute(
  server: Running,
  origin: string,
  path: string,
  token: string,
  body: unknown,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "ductus-protocol": "1",
      cookie: `${SESSION_COOKIE_NAME}=${token}`,
    },
    body: JSON.stringify(body),
  });
}

// What the dev fake server reads from the contract: the routes (ROUTE_TABLE),
// the input checks (VALIDATORS through validateInput) and, for every error,
// the answer of the route's own error vector, so an error has exactly the
// status, headers and body the contract gives it.
import { readdirSync, readFileSync } from "node:fs";

import { validateInput, VALIDATORS } from "../../contracts/index.ts";
import { ROUTE_TABLE } from "../fake-server/index.ts";

export type RouteId = keyof typeof ROUTE_TABLE;

export type Answer = {
  readonly status: number;
  readonly headers: Record<string, string | string[]>;
  readonly body: string;
};

type ErrorVector = {
  readonly kind: "success" | "error";
  readonly code?: string;
  readonly response: {
    readonly status: number;
    readonly contentType?: string;
    readonly headers?: Readonly<Record<string, string | readonly string[]>>;
    readonly body?: unknown;
  };
};

const VECTOR_DIR = new URL("../../../server/contracts/vectors/", import.meta.url);

/** route id -> code -> the first error vector with that code. */
const ERRORS = new Map<string, Map<string, ErrorVector["response"]>>();
/** Shared codes (internal, too_many_requests) may be answered by any route. */
const SHARED = new Map<string, ErrorVector["response"]>();

for (const name of readdirSync(VECTOR_DIR).filter((file) => file.endsWith(".json"))) {
  const file = JSON.parse(readFileSync(new URL(name, VECTOR_DIR), "utf8")) as {
    route: string;
    vectors: ErrorVector[];
  };
  const codes = new Map<string, ErrorVector["response"]>();
  const own = new Set<string>(Object.values(errorsOf(file.route)).flat());
  for (const vector of file.vectors) {
    if (vector.kind !== "error" || vector.code === undefined) continue;
    if (!own.has(vector.code)) {
      if (!SHARED.has(vector.code)) SHARED.set(vector.code, vector.response);
    } else if (!codes.has(vector.code)) codes.set(vector.code, vector.response);
  }
  ERRORS.set(file.route, codes);
}

function errorsOf(route: string): Readonly<Record<string, readonly string[]>> {
  return Object.hasOwn(ROUTE_TABLE, route) ? ROUTE_TABLE[route as RouteId].errors : {};
}

/** Every error code `route` may answer: its own and the shared ones. */
export function errorCodes(route: RouteId): string[] {
  return [...Object.values(errorsOf(route)).flat(), ...SHARED.keys()];
}

/** The contract answer of error `code` on `route`, or null when the route has no such error. */
export function errorAnswer(route: RouteId, code: string): Answer | null {
  const response = ERRORS.get(route)?.get(code) ?? SHARED.get(code);
  if (response === undefined) return null;
  const headers: Record<string, string | string[]> = { "cache-control": "no-store" };
  for (const [name, value] of Object.entries(response.headers ?? {}))
    headers[name] = typeof value === "string" ? value : [...value];
  if (response.contentType !== undefined) headers["content-type"] = response.contentType;
  const body = response.body;
  return {
    status: response.status,
    headers,
    body: body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body),
  };
}

/** The first of `codes` that `route` answers, as its contract answer. */
export function firstError(route: RouteId, codes: readonly string[]): Answer | null {
  const own = new Set(Object.values(errorsOf(route)).flat());
  const code = codes.find((c) => own.has(c));
  return code === undefined ? null : errorAnswer(route, code);
}

/** Whether the contract checks this part of the route's input. */
export function hasValidator(route: RouteId, part: "params" | "query" | "body"): boolean {
  return Object.hasOwn(VALIDATORS, `${route}:${part}`);
}

export function validPart(route: RouteId, part: "params" | "query" | "body", value: unknown) {
  return validateInput(route, part, value);
}

type Matcher = { id: RouteId; method: string; names: string[]; pattern: RegExp };

const MATCHERS: Matcher[] = (Object.keys(ROUTE_TABLE) as RouteId[]).map((id) => {
  const path = ROUTE_TABLE[id].path;
  return {
    id,
    method: ROUTE_TABLE[id].method,
    names: [...path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? ""),
    pattern: new RegExp("^" + path.replace(/\{\w+\}/g, "([^/]+)") + "$"),
  };
});

export type Match =
  | { kind: "route"; id: RouteId; params: Record<string, string> | null }
  | { kind: "method"; allow: string }
  | { kind: "none" };

/** The route of a path and method; params is null when a segment is not valid percent-encoding. */
export function matchRoute(method: string, pathname: string): Match {
  const onPath = MATCHERS.filter((m) => m.pattern.test(pathname));
  const route = onPath.find((m) => m.method === method);
  if (route === undefined)
    return onPath.length > 0
      ? { kind: "method", allow: onPath.map((m) => m.method).join(", ") }
      : { kind: "none" };
  const found = route.pattern.exec(pathname) ?? [];
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  try {
    route.names.forEach((name, i) => (params[name] = decodeURIComponent(found[i + 1] ?? "")));
  } catch {
    return { kind: "route", id: route.id, params: null };
  }
  return { kind: "route", id: route.id, params };
}

export function bodyType(route: RouteId): string | null {
  return ROUTE_TABLE[route].body;
}

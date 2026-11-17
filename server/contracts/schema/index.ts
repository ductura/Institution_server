// The format every route contract is written in. This package imports only the
// schema library (TypeBox) and its own files, so any client can depend on it.
import { Type, type TObject, type TSchema, type TUnion } from "@sinclair/typebox";

import { messageKeyOf } from "./message-keys.ts";

export { ERROR_MESSAGE_KEYS, messageKeyOf } from "./message-keys.ts";

/** Who may call a route. A declaration for clients and docs: the database still decides (RLS, RPC). */
export const ACCESS = [
  "anyone",
  "identity_provider",
  "signed_in",
  "student",
  "student_owner",
  "student_enrolled",
  "owner_or_course_teacher",
  "teacher",
  "course_teacher",
  "mentor_teacher",
  "institution_admin",
] as const;
export type Access = (typeof ACCESS)[number];

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type Method = (typeof METHODS)[number];

export const API_PREFIX = "/api/v1";

/**
 * An error answer. `code` is the closed word on the wire, `key` the locales key
 * a client shows (ERROR_MESSAGE_KEYS); neither is ever a sentence. `body`
 * defaults to the problem body of `errorBody`; "none" means no body, "html" a
 * page for a browser navigation.
 */
export type ErrorSpec = {
  readonly status: number;
  readonly code: string;
  readonly key: string;
  readonly body?: TSchema | "none" | "html";
};

export type SuccessSpec = {
  readonly status: number;
  readonly description: string;
  /** JSON body; omitted means no body. */
  readonly body?: TSchema;
  /** Response headers the caller relies on. */
  readonly headers?: readonly string[];
};

export type RequestSpec = {
  readonly params?: TObject;
  readonly query?: TObject;
  /**
   * A closed object, or a union of closed objects when a path parameter picks
   * the body (collaboration.comments.post {action}).
   */
  readonly body?: TObject | TUnion<TObject[]>;
  readonly contentType?: "application/json" | "application/x-www-form-urlencoded";
  readonly maxBodyBytes?: number;
  /**
   * Headers the route does not answer without (DAN-930), a closed object with
   * lowercase names. The generated client sends them; `origin` is not the
   * caller's: the client sends the origin of its base URL (a browser drops it
   * and sends its own). Not in openapi/v1.json: v1 allows no new parameter.
   */
  readonly headers?: TObject;
};

export type RouteContract = {
  /** Stable operation id, `<area>.<name>.<method>`. */
  readonly id: string;
  readonly method: Method;
  /** Full path under /api/v1, parameters as {name}. */
  readonly path: string;
  /** The Ductus file this route is carried over from (route inventory). */
  readonly inventory: string;
  readonly access: Access;
  readonly summary: string;
  readonly request: RequestSpec;
  readonly responses: readonly SuccessSpec[];
  readonly errors: readonly ErrorSpec[];
};

export function defineRoute<const R extends RouteContract>(route: R): R {
  return route;
}

export function error(status: number, code: string, body?: ErrorSpec["body"]): ErrorSpec {
  return { status, code, key: messageKeyOf(code), body: body ?? errorBody(code, status) };
}

/**
 * A request id: a lowercase UUID v4 the server makes for each request
 * (server/http/request-id.ts). It never comes from the client.
 */
export const REQUEST_ID_PATTERN =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";

/**
 * The problem fields of an error answer (S-1L.3, DAN-789): the code, the
 * locales key, the HTTP status and the request id. The server sends all four
 * on every JSON error; v1 declares them optional because its guard
 * (breaking.ts) allows only optional new response fields.
 */
export function problemFields(code: string, status: number) {
  return {
    code: Type.Optional(Type.Literal(code)),
    messageKey: Type.Optional(Type.Literal(messageKeyOf(code))),
    status: Type.Optional(Type.Literal(status)),
    requestId: Type.Optional(Type.String({ pattern: REQUEST_ID_PATTERN })),
  };
}

/**
 * The default error body: the closed word `error` (v1) and the problem fields.
 * `error` is required and a const, so several errors of one status form a
 * oneOf discriminated by the code (DAN-791, breaking.ts discriminatorOf).
 */
export function errorBody(code: string, status: number): TObject {
  return Type.Object(
    { error: Type.Literal(code), ...problemFields(code, status) },
    { additionalProperties: false },
  );
}

/** Closed object: no key outside the schema. */
export function closed<P extends Parameters<typeof Type.Object>[0]>(properties: P) {
  return Type.Object(properties, { additionalProperties: false });
}

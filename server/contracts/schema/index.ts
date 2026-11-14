// The format every route contract is written in. This package imports only the
// schema library (TypeBox) and its own files, so any client can depend on it.
import { Type, type TObject, type TSchema } from "@sinclair/typebox";

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
 * a client shows; neither is ever a sentence. `body` defaults to `{error: code}`;
 * "none" means no body, "html" a page for a browser navigation.
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
  readonly body?: TObject;
  readonly contentType?: "application/json" | "application/x-www-form-urlencoded";
  readonly maxBodyBytes?: number;
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
  return body === undefined ? { status, code, key: `errors.${code}` } : { status, code, key: `errors.${code}`, body };
}

/** The default error body: exactly one closed word. */
export function errorBody(code: string): TObject {
  return Type.Object({ error: Type.Literal(code) }, { additionalProperties: false });
}

/** Closed object: no key outside the schema. */
export function closed<P extends Parameters<typeof Type.Object>[0]>(properties: P) {
  return Type.Object(properties, { additionalProperties: false });
}

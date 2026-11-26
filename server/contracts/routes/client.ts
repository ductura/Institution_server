import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// S-1M-b (DAN-846; Ductus D-300): the preloader sends its environment in one
// call. Only the kind of system, browser and device, the app and its version
// and a class of the screen width, each from a closed list: no user agent, no
// pixels, no fingerprint. The server records it and never decides access by it.

/** The closed value lists of the body; server/http checks against these. */
export const CLIENT_CONTEXT_VALUES = {
  app: ["web", "desktop"],
  os: ["windows", "macos", "linux", "android", "ios", "other"],
  browser: ["chromium", "firefox", "safari", "other"],
  device: ["desktop", "tablet", "phone", "other"],
  // Window width classes: compact under 600 px, medium 600 to 839, expanded from 840.
  screen: ["compact", "medium", "expanded"],
} as const;

/** major.minor.patch, digits only, no leading zero; as the log catalog's version field. */
export const CLIENT_APP_VERSION_PATTERN =
  "^(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})$";

const literals = <T extends string>(values: readonly T[]) =>
  Type.Union(values.map((value) => Type.Literal(value)));

export const clientContextPost = defineRoute({
  id: "client.context.post",
  method: "POST",
  path: "/api/v1/client-context",
  inventory: "app/api/client-context/route.ts",
  access: "anyone",
  summary:
    "Records the client's environment (D-300): app, version, system, browser, device and a screen width class, each from a closed list. Works without a login, under the rate limit; the body is the JCS form of the value, and any other field, value or form is 400 invalid_input. Never used to decide access.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({
      app: literals(CLIENT_CONTEXT_VALUES.app),
      appVersion: Type.String({ pattern: CLIENT_APP_VERSION_PATTERN }),
      browser: literals(CLIENT_CONTEXT_VALUES.browser),
      device: literals(CLIENT_CONTEXT_VALUES.device),
      os: literals(CLIENT_CONTEXT_VALUES.os),
      screen: literals(CLIENT_CONTEXT_VALUES.screen),
    }),
  },
  responses: [{ status: 204, description: "recorded" }],
  errors: [
    ...MUTATION_GUARD,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(400, "invalid_input"),
  ],
});

// DAN-1568: the web reports an error nobody caught in the browser. Four
// values, each from a closed list or a version: what kind of error, its class,
// the page of the app and the app's version. No message, no stack, no address
// and nothing typed can be sent: any other field or value is 400.

/** The closed value lists of the body; server/http checks against these. */
export const CLIENT_ERROR_VALUES = {
  // A window error event, a rejected promise nobody handled, a screen that threw while rendering.
  kind: ["error", "unhandledrejection", "render"],
  errorClass: ["type_error", "range_error", "reference_error", "syntax_error", "other"],
  // The pages of the institution front as codes (the log catalogue takes no
  // path); the web maps its route to one, and any other path is "other", so no
  // id or query is sent.
  page: [
    "home",
    "how_it_works",
    "work",
    "enroll",
    "assignments",
    "assignment_courses",
    "assignment_works",
    "teacher",
    "teacher_fast_path",
    "teacher_mentorships",
    "institution",
    "institution_courses",
    "institution_users",
    "institution_rules",
    "other",
  ],
} as const;

export const clientErrorPost = defineRoute({
  id: "client.error.post",
  method: "POST",
  path: "/api/v1/client-error",
  inventory: "app/api/client-error/route.ts",
  access: "anyone",
  summary:
    "Records that the web met an error nobody caught (DAN-1568): its kind, its class, the page of the app and the app's version, each from a closed list. No message, stack, address or typed value can be sent. Works without a login, under the rate limit; the body is the JCS form of the value, and any other field, value or form is 400 invalid_input. Never used to decide access.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({
      appVersion: Type.String({ pattern: CLIENT_APP_VERSION_PATTERN }),
      errorClass: literals(CLIENT_ERROR_VALUES.errorClass),
      kind: literals(CLIENT_ERROR_VALUES.kind),
      page: literals(CLIENT_ERROR_VALUES.page),
    }),
  },
  responses: [{ status: 204, description: "recorded" }],
  errors: [
    ...MUTATION_GUARD,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(400, "invalid_input"),
  ],
});

export const clientRoutes = [clientContextPost, clientErrorPost] as const;

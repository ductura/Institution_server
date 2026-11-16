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

export const clientRoutes = [clientContextPost] as const;

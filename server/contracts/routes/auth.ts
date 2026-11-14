import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// Login and logout are browser navigations: success is a 303, failure a page.
const redirect = {
  status: 303,
  description: "redirect",
  headers: ["location", "set-cookie"],
} as const;

export const login = defineRoute({
  id: "auth.login.get",
  method: "GET",
  path: "/api/v1/auth/login",
  inventory: "app/api/auth/login/route.ts",
  access: "anyone",
  summary: "Starts AAI@EduHr login (PKCE); returnTo is narrowed to a safe local path.",
  // Open on purpose: extra parameters are ignored and an unsafe or long returnTo becomes "/", never a refusal.
  request: { query: Type.Object({ returnTo: Type.Optional(Type.String()) }) },
  responses: [redirect],
  errors: [error(503, "unavailable", "html")],
});

export const callback = defineRoute({
  id: "auth.callback.get",
  method: "GET",
  path: "/api/v1/auth/callback",
  inventory: "app/api/auth/callback/route.ts",
  access: "anyone",
  summary: "Return from the identity provider; checks state and PKCE, opens the session.",
  request: {
    // Open on purpose: the provider may add its own parameters (iss, session_state).
    query: Type.Object({
      code: Type.Optional(Type.String({ maxLength: 4096 })),
      state: Type.Optional(Type.String({ maxLength: 512 })),
    }),
  },
  responses: [redirect],
  errors: [
    error(400, "login_failed", "html"),
    error(403, "login_refused", "html"),
    error(503, "unavailable", "html"),
  ],
});

export const logout = defineRoute({
  id: "auth.logout.post",
  method: "POST",
  path: "/api/v1/auth/logout",
  inventory: "app/api/auth/logout/route.ts",
  access: "signed_in",
  summary: "Closes the current session. Same Origin only; an empty body.",
  request: {},
  responses: [redirect],
  errors: [error(403, "forbidden", "html"), error(503, "unavailable", "html")],
});

export const logoutAll = defineRoute({
  id: "auth.logout-all.post",
  method: "POST",
  path: "/api/v1/auth/logout-all",
  inventory: "app/api/auth/logout-all/route.ts",
  access: "signed_in",
  summary: "Closes every session of the caller; on failure keeps the cookie.",
  request: {},
  responses: [redirect],
  errors: [error(403, "forbidden", "html"), error(503, "unavailable", "html")],
});

export const backchannelLogout = defineRoute({
  id: "auth.backchannel-logout.post",
  method: "POST",
  path: "/api/v1/auth/backchannel-logout",
  inventory: "app/api/auth/backchannel-logout/route.ts",
  access: "identity_provider",
  summary: "OIDC back-channel logout: the provider posts a signed logout token, no cookie.",
  request: {
    contentType: "application/x-www-form-urlencoded",
    maxBodyBytes: 16 * 1024,
    // Open on purpose: the provider may send other form fields, which are ignored.
    body: Type.Object({ logout_token: Type.String({ minLength: 1 }) }),
  },
  responses: [{ status: 200, description: "sessions closed" }],
  errors: [error(400, "invalid_logout_token", "none"), error(503, "unavailable", "none")],
});

export const authRoutes = [login, callback, logout, logoutAll, backchannelLogout] as const;

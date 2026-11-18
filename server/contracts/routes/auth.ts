import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";
import data from "./sign-in-failure.json" with { type: "json" };

/** A failed login's code on the sign-in page: the one closed list (DAN-1081). */
export type SignInFailureCode = "login_failed" | "provider_unavailable";

/**
 * Where a failed login ends (DAN-1081, Ductus#2031 V1 to V5): a 303 to `page`
 * of the configured origin whose query `param` is one of `codes`, nothing else.
 * The data @ductura/contracts publishes as auth/sign-in-failure.json; read
 * strictly here, so a third code or a stray key fails at load.
 */
export const SIGN_IN_FAILURE: {
  readonly page: "/prijava";
  readonly param: string;
  readonly codes: readonly { readonly code: SignInFailureCode; readonly messageKey: string }[];
} = readSignInFailure(data);

/** Reads the data strictly; exported for its test. */
export function readSignInFailure(raw: unknown): typeof SIGN_IN_FAILURE {
  const fail = (why: string): never => {
    throw new Error(`sign-in-failure.json: ${why}`);
  };
  const keys = (o: object) => Object.keys(o).sort().join(",");
  if (typeof raw !== "object" || raw === null) return fail("not an object");
  const { format, page, param, codes } = raw as Record<string, unknown>;
  if (keys(raw) !== "codes,format,page,param") fail("keys");
  if (format !== "ductura-sign-in-failure-v1") fail("format");
  if (page !== "/prijava") fail("page");
  if (typeof param !== "string" || !/^[a-z]+$/u.test(param)) fail("param");
  const wanted: readonly SignInFailureCode[] = ["login_failed", "provider_unavailable"];
  if (!Array.isArray(codes) || codes.length !== wanted.length) return fail("codes");
  const read = codes.map((entry: unknown, at) => {
    if (typeof entry !== "object" || entry === null || keys(entry) !== "code,messageKey")
      return fail(`code ${at}`);
    const { code, messageKey } = entry as Record<string, unknown>;
    if (code !== wanted[at] || typeof messageKey !== "string") return fail(`code ${at}`);
    return Object.freeze({ code: code as SignInFailureCode, messageKey });
  });
  return Object.freeze({ page: "/prijava", param: param as string, codes: Object.freeze(read) });
}

// Login and logout are browser navigations: success is a 303, failure a page.
const redirect = {
  status: 303,
  description: "redirect",
  headers: ["location", "set-cookie"],
} as const;

// Login and callback end on a 303 when they fail too (DAN-1081); their
// statuses below stay declared until v2, which may remove them.
const loginRedirect = {
  ...redirect,
  description: "redirect; a failed login goes to /prijava with a code (auth/sign-in-failure.json)",
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
  responses: [loginRedirect],
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
  responses: [loginRedirect],
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

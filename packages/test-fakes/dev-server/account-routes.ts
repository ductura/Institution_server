// Platform, client context, sign-in and profile routes of the dev fake server.
// Sign-in goes only through the local role switch: login sends the browser
// there, the callback ends at "/" and no provider is ever called (D-09).
import { API_VERSION, MIN_CLIENT_VERSION } from "../../../server/contracts/index.ts";
import { clearedSessionCookie, type Handlers } from "./server.ts";
import { fakeJournalScope, fakeSessionTag, INSTITUTION } from "./state.ts";

/** Invented WebAuthn values (32 bytes as base64url): the fake never checks a ceremony. */
const CHALLENGE = Buffer.alloc(32, 7).toString("base64url");
const RP_ID = "localhost";

export const ACCOUNT_HANDLERS: Handlers = {
  "platform.health.get": () => ({
    status: 200,
    body: {
      status: "ok",
      state: "ok",
      apiVersion: API_VERSION,
      serverVersion: "0.0.0",
      minClientVersion: MIN_CLIENT_VERSION,
    },
  }),
  "platform.ready.get": () => ({
    status: 200,
    body: {
      status: "ready",
      capabilities: { database: "ok", storage: "ok", signing: "ok", queue: "ok" },
    },
  }),
  "platform.status.get": ({ now }) => ({
    status: 200,
    body: {
      checkedAt: now.toISOString(),
      components: { writing: "radi", submission: "radi", mentorView: "radi" },
    },
  }),
  "client.context.post": () => ({ status: 204 }),
  "downloads.manifest.get": () => ({ status: 200, body: { packages: [] } }),

  "auth.login.get": ({ query }) => {
    const back = typeof query?.returnTo === "string" ? query.returnTo : "/";
    return {
      status: 303,
      headers: {
        location: `/__lazni/uloga?povratak=${encodeURIComponent(back)}`,
        "set-cookie": [clearedSessionCookie()],
      },
    };
  },
  "auth.callback.get": () => ({
    status: 303,
    headers: { location: "/", "set-cookie": [clearedSessionCookie()] },
  }),
  "auth.logout.post": ({ state, token }) => {
    if (token !== null) state.sessions.delete(token);
    return { status: 303, headers: { location: "/", "set-cookie": [clearedSessionCookie()] } };
  },
  "auth.logout-all.post": ({ state, account }) => {
    for (const [token, id] of state.sessions) if (id === account?.id) state.sessions.delete(token);
    return { status: 303, headers: { location: "/", "set-cookie": [clearedSessionCookie()] } };
  },
  "auth.backchannel-logout.post": () => ({ status: 200 }),
  "auth.webauthn-challenge.post": ({ body, account }) => ({
    status: 200,
    body:
      body.purpose === "registration"
        ? {
            challenge: CHALLENGE,
            rpId: RP_ID,
            timeoutMs: 60_000,
            purpose: "registration",
            userHandle: Buffer.from((account?.id ?? "").replaceAll("-", ""), "hex").toString(
              "base64url",
            ),
          }
        : {
            challenge: CHALLENGE,
            rpId: RP_ID,
            timeoutMs: 60_000,
            purpose: "assertion",
            allowCredentials: [],
          },
  }),
  "auth.webauthn-registration.post": () => ({ status: 204 }),
  "auth.webauthn-assertion.post": () => ({ status: 204 }),

  "profile.me.get": ({ account, token }) =>
    account === null || token === null
      ? { error: "unauthorized" }
      : {
          status: 200,
          body: {
            institution: { ...INSTITUTION },
            roles: [...account.roles],
            displayName: `${account.givenName} ${account.familyName}`,
            journalScope: fakeJournalScope(account.id),
            sessionTag: fakeSessionTag(token),
          },
        },
  // SRV-1403: a fake teacher is affiliated by an unscoped hrEdu value; every
  // other account stays a student with the closed code.
  "profile.staff-affiliation.get": ({ account, now }) => {
    if (account === null) return { error: "unauthorized" };
    return account.roles.includes("teacher")
      ? {
          status: 200,
          body: {
            confirmed: true,
            source: "hrEduPersonAffiliation",
            confirmedAt: now.toISOString(),
          },
        }
      : { status: 200, body: { confirmed: false, code: "staff_affiliation_missing" } };
  },
  "profile.interface-locale.get": ({ account }) =>
    account === null
      ? { error: "unauthorized" }
      : { status: 200, body: { locale: account.locale } },
  "profile.interface-locale.post": ({ account, body }) => {
    if (account === null) return { error: "unauthorized" };
    account.locale = body.locale;
    return { status: 200, body: { locale: body.locale } };
  },
};

import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { checkVectors, ROUTES } from "../../../server/contracts/index.ts";
import {
  answerDev,
  CODES,
  createState,
  DEFAULT_PORT,
  DEV_HANDLERS,
  devServerPort,
  IDS,
  type AccountKey,
  type State,
} from "./index.ts";

// The one string format of the contracts, as server/contracts/vectors.test.ts registers it.
if (!FormatRegistry.Has("date-time"))
  FormatRegistry.Set(
    "date-time",
    (value) =>
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
      !Number.isNaN(Date.parse(value)),
  );

const PORT_VAR = "DUCTURA_LAZNI_PORT";

type Sent = { method?: string; query?: string; body?: unknown; headers?: Record<string, string> };

/** One request through answerDev; a JSON body gets its content type. */
async function send(state: State, path: string, sent: Sent = {}) {
  const body = sent.body === undefined ? "" : JSON.stringify(sent.body);
  const headers: Record<string, string> = { ...sent.headers };
  if (sent.body !== undefined) headers["content-type"] ??= "application/json";
  const answer = await answerDev(state, DEV_HANDLERS, {
    method: sent.method ?? (sent.body === undefined ? "GET" : "POST"),
    url: path + (sent.query ?? ""),
    headers,
    body: Buffer.from(body),
  });
  return { ...answer, json: answer.body === "" ? undefined : (JSON.parse(answer.body) as unknown) };
}

/** A cookie header of a session opened by the role switch. */
async function signIn(state: State, as: AccountKey): Promise<Record<string, string>> {
  const answer = await send(state, `/__lazni/uloga?kao=${as}`);
  const cookie = [answer.headers["set-cookie"] ?? []].flat()[0] ?? "";
  return { cookie: cookie.split(";")[0] ?? "" };
}

/** Contract problems of one success answer of `route` (empty when it fits). */
function contractProblems(route: string, answer: Awaited<ReturnType<typeof send>>): string[] {
  const contract = ROUTES.find((r) => r.id === route);
  if (contract === undefined) return [`no route ${route}`];
  const type = answer.headers["content-type"];
  const vector = {
    name: "lazni",
    kind: "success",
    request: {},
    response: {
      status: answer.status,
      ...(typeof type === "string" ? { contentType: type.split(";")[0] } : {}),
      headers: answer.headers,
      ...(answer.json === undefined ? {} : { body: answer.json }),
    },
  };
  return checkVectors([contract], { [route]: { route, vectors: [vector] } }, (s, v) =>
    Value.Check(s, v),
  ).filter((p) => p.startsWith(`${route}: lazni: `) && !p.includes("request "));
}

describe("dev fake server: sessions and switches", () => {
  it("opens a session only through the role switch", async () => {
    const state = createState();
    const anonymous = await send(state, "/api/v1/me");
    expect(anonymous.status).toBe(401);
    expect(anonymous.json).toMatchObject({ error: "unauthorized" });
    const me = await send(state, "/api/v1/me", { headers: await signIn(state, "nastavnik") });
    expect(me.json).toMatchObject({ roles: ["teacher"], displayName: "Petar Kranjčec" });
    expect(contractProblems("profile.me.get", me)).toEqual([]);
  });

  it("login sends the browser to the role switch, never to a provider", async () => {
    const login = await send(createState(), "/api/v1/auth/login", { query: "?returnTo=/radovi" });
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe("/__lazni/uloga?povratak=%2Fradovi");
  });

  it("refuses an unknown account and a return to another host", async () => {
    const state = createState();
    expect((await send(state, "/__lazni/uloga?kao=rektor")).status).toBe(400);
    const away = await send(state, "/__lazni/uloga?kao=student&povratak=//drugi.invalid/");
    expect(away.status).toBe(200);
    const back = await send(state, "/__lazni/uloga?kao=student&povratak=/moji-zadaci");
    expect(back.headers.location).toBe("/moji-zadaci");
  });

  it("logout closes the session", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    const out = await send(state, "/api/v1/auth/logout", { method: "POST", headers });
    expect(out.status).toBe(303);
    expect((await send(state, "/api/v1/me", { headers })).status).toBe(401);
  });

  it("answers an asked error from the catalogue, by query or header", async () => {
    const state = createState();
    const byQuery = await send(state, "/api/v1/health", { query: "?__lazni_greska=internal" });
    expect(byQuery.status).toBe(500);
    expect(byQuery.json).toMatchObject({ error: "internal", messageKey: "errors.internal" });
    const headers = { ...(await signIn(state, "student")), "x-lazni-greska": "too_many_attempts" };
    const byHeader = await send(state, "/api/v1/institution/enrollments", {
      body: { code: "x" },
      headers,
    });
    expect(byHeader.status).toBe(429);
    const unknown = await send(state, "/api/v1/health", { query: "?__lazni_greska=nema" });
    expect(unknown.status).toBe(400);
    expect(unknown.json).toMatchObject({ lazniServer: "nepoznata_greska" });
  });

  it("waits as long as asked", async () => {
    const started = Date.now();
    await send(createState(), "/api/v1/health", { query: "?__lazni_kasnjenje=40" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it("refuses input as the contract does", async () => {
    const state = createState();
    const headers = await signIn(state, "student-2");
    const wrongType = await send(state, "/api/v1/institution/enrollments", {
      body: { code: "x" },
      headers: { ...headers, "content-type": "text/plain" },
    });
    expect(wrongType.status).toBe(415);
    const invalid = await send(state, "/api/v1/institution/enrollments", {
      body: { code: 5 },
      headers,
    });
    expect([invalid.status, invalid.json]).toMatchObject([422, { error: "invalid_input" }]);
    expect((await send(state, "/api/v1/nema")).status).toBe(404);
    expect((await send(state, "/api/v1/health", { method: "DELETE" })).status).toBe(405);
  });

  it("takes the port from DUCTURA_LAZNI_PORT, never 3000 to 3004", () => {
    expect(devServerPort({})).toBe(DEFAULT_PORT);
    expect(devServerPort({ [PORT_VAR]: "4123" })).toBe(4123);
    for (const port of ["3000", "3004", "80", "abc", "70000"])
      expect(typeof devServerPort({ [PORT_VAR]: port })).toBe("string");
  });
});

describe("dev fake server: platform and institution", () => {
  it.each(["/api/v1/health", "/api/v1/ready", "/api/v1/status", "/api/v1/downloads/manifest"])(
    "%s fits the contract",
    async (path) => {
      const answer = await send(createState(), path);
      const route = ROUTES.find((r) => r.path === path)?.id ?? "";
      expect(answer.status).toBe(200);
      expect(contractProblems(route, answer)).toEqual([]);
    },
  );

  it("enrols with the valid code and refuses the expired one, then too many guesses", async () => {
    const state = createState();
    const headers = await signIn(state, "student-2");
    const url = "/api/v1/institution/enrollments";
    const ok = await send(state, url, { body: { code: CODES.valid }, headers });
    expect(ok.json).toEqual({ courseId: IDS.course });
    expect(contractProblems("institution.enrollments.post", ok)).toEqual([]);
    for (let i = 0; i < 5; i++)
      expect(
        (await send(state, url, { body: { code: CODES.expired }, headers })).json,
      ).toMatchObject({
        error: "refused",
      });
    expect((await send(state, url, { body: { code: CODES.valid }, headers })).status).toBe(429);
  });

  it("lets only a teacher of the course issue its code", async () => {
    const state = createState();
    const url = `/api/v1/institution/courses/${IDS.emptyCourse}/enrollment-code`;
    const body = { validUntil: "2027-06-30T21:59:00Z" };
    const other = await send(state, url, { body, headers: await signIn(state, "nastavnik-2") });
    expect(other.status).toBe(403);
    const holder = await send(state, url, { body, headers: await signIn(state, "nastavnik") });
    expect(contractProblems("institution.enrollment-code.post", holder)).toEqual([]);
  });

  it("acknowledges the notice of the current version only", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    const url = `/api/v1/institution/assignments/${IDS.assignment}/acknowledgment`;
    const fingerprint = "0".repeat(64);
    const stale = await send(state, url, { body: { versionNo: 2, fingerprint }, headers });
    expect(stale.json).toMatchObject({ error: "conflict" });
    const ok = await send(state, url, { body: { versionNo: 1, fingerprint }, headers });
    expect(contractProblems("institution.acknowledgment.post", ok)).toEqual([]);
  });

  it("an administrator confirms the account without a role as a teacher", async () => {
    const state = createState();
    const url = `/api/v1/institution/teachers/${IDS.noRole}/role-confirmation`;
    const asTeacher = await send(state, url, {
      body: {},
      headers: await signIn(state, "nastavnik"),
    });
    expect(asTeacher.status).toBe(403);
    const ok = await send(state, url, { body: {}, headers: await signIn(state, "administrator") });
    expect(contractProblems("institution.role-confirmation.post", ok)).toEqual([]);
    const me = await send(state, "/api/v1/me", { headers: await signIn(state, "bez-uloge") });
    expect(me.json).toMatchObject({ roles: ["teacher"] });
  });
});

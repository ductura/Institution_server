import { describe, expect, it } from "vitest";

import { ROUTES } from "../../../server/contracts/index.ts";
import { CODES, createState, DEFAULT_PORT, devServerPort, IDS } from "./index.ts";
import { FAKE_AAI_IDENTIFIERS } from "./roster-import-routes.ts";
import { contractProblems, send, signIn } from "./testing.ts";

const PORT_VAR = "DUCTURA_LAZNI_PORT";

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

  // SEED-OIDC-OPERATER: demo-operater of db/main/local/seed.sql, a second
  // administrator who stands in for the operator, as on the real stack.
  it("the operater switch opens a session of the seed's operator, Oto Operić", async () => {
    const state = createState();
    expect((await send(state, "/__lazni/uloga")).body).toContain("kao=operater");
    const headers = await signIn(state, "operater");
    const me = await send(state, "/api/v1/me", { headers });
    expect(me.json).toMatchObject({ roles: ["institution_admin"], displayName: "Oto Operić" });
    expect(contractProblems("profile.me.get", me)).toEqual([]);
    const ops = await send(state, "/api/v1/ops/pilot-metrics", { headers });
    expect(ops.status).toBe(200);
    expect(FAKE_AAI_IDENTIFIERS.operater).toBe("demo-operater@demo.ductus.test");
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

  it("answers one 404 for the administrator themself, a student and a missing person", async () => {
    const state = createState();
    const headers = await signIn(state, "administrator");
    for (const id of [IDS.admin, IDS.student, "00000000-0000-4000-8000-00000000dead"]) {
      const answer = await send(state, `/api/v1/institution/teachers/${id}/role-confirmation`, {
        body: {},
        headers,
      });
      expect(answer.status).toBe(404);
    }
    const student = await send(state, "/api/v1/me", { headers: await signIn(state, "student") });
    expect((student.json as { roles: string[] }).roles).not.toContain("teacher");
  });
});

describe("dev fake server: institution rules as the database keeps them", () => {
  const A = `/api/v1/institution/assignments/${IDS.assignment}`;

  it("refuses an impossible expiry with 422 and keeps the working code", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    for (const validUntil of ["2027-99-99T00:00:00Z", "2027-02-30T00:00:00Z"]) {
      const answer = await send(
        state,
        `/api/v1/institution/courses/${IDS.course}/enrollment-code`,
        {
          body: { validUntil },
          headers,
        },
      );
      expect([answer.status, answer.json]).toMatchObject([422, { error: "invalid_input" }]);
    }
    const student = await signIn(state, "student-2");
    const enrolled = await send(state, "/api/v1/institution/enrollments", {
      body: { code: CODES.valid },
      headers: student,
    });
    expect(enrolled.status).toBe(200);
  });

  it("compares enrolment codes without case, spaces or hyphens", async () => {
    const state = createState();
    const headers = await signIn(state, "student-2");
    const answer = await send(state, "/api/v1/institution/enrollments", {
      body: { code: " upis-2026-demo " },
      headers,
    });
    expect(answer.json).toEqual({ courseId: IDS.course });
  });

  it("ends a teacher's course access when the role is revoked", async () => {
    const state = createState();
    await send(state, `/api/v1/institution/teachers/${IDS.teacher}/role-revocation`, {
      body: {},
      headers: await signIn(state, "administrator"),
    });
    const answer = await send(state, `/api/v1/institution/courses/${IDS.course}/enrollment-code`, {
      body: { validUntil: "2027-06-30T21:59:00Z" },
      headers: await signIn(state, "nastavnik"),
    });
    expect(answer.status).toBe(403);
  });

  it("refuses a version that tightens the rules and stores instants in UTC", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    const version = {
      expectedVersion: 1,
      title: "Izmišljeni naslov",
      instructions: "Izmišljene upute.",
      workType: "seminar_paper",
      opensAt: "2026-10-01T08:00:00+02:00",
      dueAt: "2027-01-31T23:59:00+01:00",
      aiPolicy: "partially_allowed",
      aiPurposes: ["proofreading"],
      evidenceProfile: "basic",
      importAllowed: false,
      wordMin: 1500,
      wordMax: 2500,
    };
    for (const change of [
      { wordMin: 2000 },
      { wordMax: 2000 },
      { aiPolicy: "encouraged" },
      { aiPurposes: ["translation"] },
    ]) {
      const refused = await send(state, `${A}/versions`, {
        body: { ...version, ...change },
        headers,
      });
      expect(refused.status, JSON.stringify(change)).toBe(422);
    }
    const ok = await send(state, `${A}/versions`, { body: { ...version, wordMin: 1000 }, headers });
    expect(ok.status).toBe(201);
    // D-282: the version above turned import off (the demo allows it, SRV-1803); it never comes back on.
    const reopened = await send(state, `${A}/versions`, {
      body: { ...version, expectedVersion: 2, wordMin: 1000, importAllowed: true },
      headers,
    });
    expect(reopened.status).toBe(422);
    expect(state.assignments[0]?.content).toMatchObject({
      opensAt: "2026-10-01T06:00:00.000Z",
      dueAt: "2027-01-31T22:59:00.000Z",
    });
  });

  it("keeps one work-language exception for both addressing forms", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    await send(state, `${A}/students/${IDS.student}/work-language`, {
      body: { language: "en" },
      headers,
    });
    const cleared = await send(state, `${A}/works/${IDS.document}/work-language`, {
      body: { language: null },
      headers,
    });
    expect(cleared.json).toEqual({ language: "hr" });
    expect(state.assignments[0]?.studentLanguage.has(IDS.student)).toBe(false);
  });
});

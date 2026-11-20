import { describe, expect, it } from "vitest";

import { ROUTE_TABLE } from "../fake-server/index.ts";
import { errorCodes, type RouteId } from "./contract.ts";
import {
  createState,
  DEV_HANDLERS,
  EMPTY_DOCUMENT,
  IDS,
  type AccountKey,
  type State,
} from "./index.ts";
import { contractProblems, evidenceSegment, send, signIn, type Sent } from "./testing.ts";

// Every route of the contract answers on the dev fake server, and the answer
// fits the contract. A route added to ROUTE_TABLE without a handler or without
// a scenario here fails this file.

type Step = Sent & { readonly path: string; readonly as?: AccountKey };
type Scenario = { readonly before?: readonly Step[]; readonly request: Step };

const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };
const EVIDENCE = { ...ORIGIN, "ductus-protocol": "1" };
const SEGMENT = evidenceSegment(createState());
const commit = (txid: string, baseRevision: number): Step => ({
  path: "/api/v1/evidence/commit",
  as: "student",
  headers: EVIDENCE,
  body: {
    documentId: IDS.document,
    clientTransactionId: txid,
    baseRevision,
    segments: [SEGMENT],
    document: EMPTY_DOCUMENT,
  },
});
const ANCHOR = {
  nodeId: "0a000000-0000-4000-8000-000000000001",
  quote: "Izmišljeno",
  prefix: "",
  suffix: "",
  startHint: 0,
  endHint: 10,
};
const LIVE = { nodes: [], schemaVersion: 1 };
const livePut: Step = {
  path: `/api/v1/live/${IDS.document}`,
  as: "student",
  method: "PUT",
  headers: { ...ORIGIN, "if-none-match": "*" },
  body: LIVE,
};
const createRequest: Step = {
  path: "/api/v1/revision-requests/create",
  as: "nastavnik",
  headers: ORIGIN,
  body: {
    anchor: ANCHOR,
    documentId: IDS.document,
    instruction: "Izmišljena uputa.",
    requestedRevision: 0,
  },
};
const SETTING = {
  level: "personal",
  course: null,
  key: "notifications.email",
  value: false,
  locked: false,
  min: null,
  max: null,
};
const REPORT = {
  appVersion: "1.4.0",
  browser: { family: "firefox", major: 140 },
  category: "technical",
  description: "Izmišljeni opis.",
  route: null,
  syncState: null,
};
const VERSION = {
  expectedVersion: 1,
  title: "Izmišljeni naslov",
  instructions: "Izmišljene upute.",
  workType: "seminar_paper",
  opensAt: "2026-10-01T06:00:00Z",
  dueAt: "2027-01-31T22:59:00Z",
  aiPolicy: "partially_allowed",
  aiPurposes: ["proofreading"],
  evidenceProfile: "basic",
  importAllowed: false,
  wordMin: 1500,
  wordMax: 2500,
};
const A = `/api/v1/institution/assignments/${IDS.assignment}`;
const C = `/api/v1/institution/courses/${IDS.course}`;

const SCENARIOS: Record<RouteId, Scenario> = {
  "auth.backchannel-logout.post": {
    request: {
      path: "/api/v1/auth/backchannel-logout",
      body: "logout_token=izmisljeni",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    },
  },
  "auth.callback.get": { request: { path: "/api/v1/auth/callback" } },
  "auth.login.get": { request: { path: "/api/v1/auth/login" } },
  "auth.logout-all.post": {
    request: { path: "/api/v1/auth/logout-all", as: "student", method: "POST" },
  },
  "auth.logout.post": { request: { path: "/api/v1/auth/logout", as: "student", method: "POST" } },
  "auth.webauthn-assertion.post": {
    request: {
      path: "/api/v1/auth/webauthn/assertion",
      as: "student",
      body: { authenticatorData: "AA", clientDataJSON: "AA", credentialId: "AA", signature: "AA" },
    },
  },
  "auth.webauthn-challenge.post": {
    request: {
      path: "/api/v1/auth/webauthn/challenge",
      as: "student",
      body: { purpose: "registration" },
    },
  },
  "auth.webauthn-registration.post": {
    request: {
      path: "/api/v1/auth/webauthn/registration",
      as: "student",
      body: { authenticatorData: "AA", clientDataJSON: "AA", credentialId: "AA" },
    },
  },
  "client.context.post": {
    request: {
      path: "/api/v1/client-context",
      body: {
        app: "web",
        appVersion: "1.0.0",
        browser: "firefox",
        device: "desktop",
        os: "linux",
        screen: "expanded",
      },
    },
  },
  "collaboration.comments.post": {
    before: [
      {
        path: "/api/v1/comments/create",
        as: "nastavnik",
        body: { anchor: ANCHOR, body: "Izmišljeni komentar.", documentId: IDS.document },
      },
    ],
    request: { path: "/api/v1/comments/list", as: "student", body: { documentId: IDS.document } },
  },
  "collaboration.revision-requests.post": {
    before: [createRequest],
    request: {
      path: "/api/v1/revision-requests/list",
      as: "student",
      body: { documentId: IDS.document },
    },
  },
  "downloads.manifest.get": { request: { path: "/api/v1/downloads/manifest" } },
  "evidence.commit.post": { request: commit("izmisljena-transakcija-1", 0) },
  "evidence.open.post": {
    request: {
      path: "/api/v1/evidence/open",
      as: "student",
      headers: EVIDENCE,
      body: { assignmentId: IDS.assignment },
    },
  },
  "evidence.replay.post": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: {
      path: "/api/v1/evidence/replay",
      as: "nastavnik",
      headers: EVIDENCE,
      body: { documentId: IDS.document, from: 0 },
    },
  },
  "institution.acknowledgment.post": {
    request: {
      path: `${A}/acknowledgment`,
      as: "student",
      body: { versionNo: 1, fingerprint: "0".repeat(64) },
    },
  },
  "institution.assignment-versions.post": {
    request: { path: `${A}/versions`, as: "nastavnik", body: VERSION },
  },
  "institution.admin-courses.post": {
    request: {
      path: "/api/v1/institution/admin/courses",
      as: "administrator",
      body: {
        name: "Izmišljeni kolegij administratorice",
        academicYear: "2026/2027",
        aiPolicy: "prohibited",
        holderId: IDS.teacher2,
        groups: ["Grupa A"],
      },
    },
  },
  "institution.course-assignments.post": {
    request: {
      path: `${C}/assignments`,
      as: "nastavnik",
      body: (({ expectedVersion: _v, ...content }) => ({
        requestKey: "b15e6f70-8192-4da4-8eb5-f60718293a05",
        ...content,
      }))(VERSION),
    },
  },
  "institution.course-group-teachers.post": {
    request: {
      path: `/api/v1/institution/groups/${IDS.groupA}/teachers`,
      as: "nastavnik",
      body: { teacherId: IDS.teacher2 },
    },
  },
  "institution.course-groups.get": { request: { path: `${C}/groups`, as: "nastavnik" } },
  "institution.course-groups.post": {
    request: { path: `${C}/groups`, as: "nastavnik", body: { name: "Grupa C" } },
  },
  "institution.courses.post": {
    request: {
      path: "/api/v1/institution/courses",
      as: "nastavnik",
      body: { name: "Izmišljeni kolegij", academicYear: "2026/2027", aiPolicy: "encouraged" },
    },
  },
  "institution.enrollment-code-revocation.post": {
    request: { path: `${C}/enrollment-code/revocation`, as: "nastavnik", body: {} },
  },
  "institution.enrollment-code.post": {
    request: {
      path: `${C}/enrollment-code`,
      as: "nastavnik",
      body: { validUntil: "2027-06-30T21:59:00Z" },
    },
  },
  "institution.enrollments.post": {
    request: {
      path: "/api/v1/institution/enrollments",
      as: "student-2",
      body: { code: "UPIS2026DEMO" },
    },
  },
  "institution.role-confirmation.post": {
    request: {
      path: `/api/v1/institution/teachers/${IDS.noRole}/role-confirmation`,
      as: "administrator",
      body: {},
    },
  },
  "institution.role-revocation.post": {
    request: {
      path: `/api/v1/institution/teachers/${IDS.teacher2}/role-revocation`,
      as: "administrator",
      body: {},
    },
  },
  "institution.student-removal.post": {
    request: { path: `${C}/students/${IDS.student}/removal`, as: "nastavnik", body: {} },
  },
  "institution.student-return.post": {
    request: { path: `${C}/students/${IDS.student}/return-permission`, as: "nastavnik", body: {} },
  },
  "institution.student-work-language.post": {
    request: {
      path: `${A}/students/${IDS.student}/work-language`,
      as: "nastavnik",
      body: { language: "en" },
    },
  },
  "institution.work-language.post": {
    request: {
      path: `${A}/work-language`,
      as: "nastavnik",
      body: { expectedVersion: 1, language: "en" },
    },
  },
  "institution.work-work-language.post": {
    request: {
      path: `${A}/works/${IDS.document}/work-language`,
      as: "nastavnik",
      body: { language: null },
    },
  },
  "live.document.get": {
    before: [livePut],
    request: {
      path: `/api/v1/live/${IDS.document}`,
      as: "nastavnik",
      headers: { "ductus-protocol": "1" },
    },
  },
  "live.document.put": { request: livePut },
  "platform.health.get": { request: { path: "/api/v1/health" } },
  "platform.ready.get": { request: { path: "/api/v1/ready" } },
  "platform.status.get": { request: { path: "/api/v1/status" } },
  "profile.interface-locale.get": {
    request: { path: "/api/v1/profile/interface-locale", as: "student" },
  },
  "profile.interface-locale.post": {
    request: { path: "/api/v1/profile/interface-locale", as: "student", body: { locale: "en" } },
  },
  "profile.me.get": { request: { path: "/api/v1/me", as: "administrator" } },
  "projection.process-summary.post": {
    request: {
      path: "/api/v1/process-summary",
      as: "nastavnik",
      body: { documentId: IDS.document },
    },
  },
  "settings.catalogue.get": { request: { path: "/api/v1/settings/catalogue", as: "student" } },
  "settings.values.get": {
    request: {
      path: "/api/v1/settings/values",
      as: "nastavnik",
      query: `?level=course&course=${IDS.course}`,
    },
  },
  "settings.values.put": {
    request: { path: "/api/v1/settings/values", as: "student", method: "PUT", body: SETTING },
  },
  "student.access-log.get": {
    request: { path: `/api/v1/student/works/${IDS.document}/access-log`, as: "student" },
  },
  "student.assignment-work.get": {
    request: { path: "/api/v1/student/assignment-work", as: "student" },
  },
  "student.assignments.get": { request: { path: "/api/v1/student/assignments", as: "student" } },
  "student.enrollments.post": {
    request: {
      path: "/api/v1/student/enrollments",
      as: "student-2",
      body: { code: "UPIS2026DEMO" },
    },
  },
  "student.notice.get": {
    request: { path: `${A.replace("/institution/", "/student/")}/notice`, as: "student" },
  },
  "student.notice-read.post": {
    request: {
      path: `${A.replace("/institution/", "/student/")}/notice-read`,
      as: "student",
      body: { versionNo: 1 },
    },
  },
  "submission.submit.post": {
    before: [commit("izmisljena-transakcija-1", 0)],
    request: {
      path: "/api/v1/submission",
      as: "student",
      headers: EVIDENCE,
      body: { documentId: IDS.document, revision: 1 },
    },
  },
  "support.problem-report.post": {
    request: { path: "/api/v1/support/problem-report", as: "student", body: REPORT },
  },
  "teacher.access.get": { request: { path: "/api/v1/teacher/access", as: "nastavnik" } },
  "teacher.assignment-submissions.post": {
    request: {
      path: "/api/v1/teacher/assignment-submissions",
      as: "nastavnik",
      body: { assignmentIds: [IDS.assignment] },
    },
  },
  "teacher.courses.get": { request: { path: "/api/v1/teacher/courses", as: "nastavnik-2" } },
  "teacher.fast-path.post": {
    request: {
      path: "/api/v1/teacher/fast-path",
      as: "nastavnik",
      body: { assignmentId: IDS.assignment },
    },
  },
  "teacher.mentorship.get": {
    request: { path: `/api/v1/teacher/mentorships/${IDS.mentorship}`, as: "nastavnik" },
  },
  "teacher.mentorships.get": { request: { path: "/api/v1/teacher/mentorships", as: "nastavnik" } },
  "teacher.submissions.get": {
    before: [
      commit("izmisljena-transakcija-1", 0),
      {
        path: "/api/v1/submission",
        as: "student",
        headers: EVIDENCE,
        body: { documentId: IDS.document, revision: 1 },
      },
    ],
    request: { path: `/api/v1/teacher/assignments/${IDS.assignment}/submissions`, as: "nastavnik" },
  },
};

async function run(state: State, step: Step) {
  const session = step.as === undefined ? {} : await signIn(state, step.as);
  const raw = typeof step.body === "string";
  return send(state, step.path, {
    ...step,
    ...(raw ? { body: undefined, raw: step.body as string } : {}),
    method: step.method ?? (step.body === undefined ? ROUTE_TABLE[routeOf(step)].method : "POST"),
    headers: { ...session, ...step.headers },
  });
}

function routeOf(step: Step): RouteId {
  const found = (Object.keys(ROUTE_TABLE) as RouteId[]).find((id) => {
    const pattern = new RegExp("^" + ROUTE_TABLE[id].path.replace(/\{\w+\}/g, "[^/]+") + "$");
    return pattern.test(step.path);
  });
  return found ?? "platform.health.get";
}

const ROUTES = Object.keys(ROUTE_TABLE) as RouteId[];

describe("dev fake server covers the whole contract", () => {
  it("has a handler and a scenario for every route of ROUTE_TABLE, and nothing else", () => {
    expect(Object.keys(DEV_HANDLERS).sort()).toEqual([...ROUTES].sort());
    expect(ROUTES.filter((route) => typeof DEV_HANDLERS[route] !== "function")).toEqual([]);
    expect(Object.keys(SCENARIOS).sort()).toEqual([...ROUTES].sort());
  });

  it.each(ROUTES)("%s answers (not 501) and the answer fits the contract", async (route) => {
    const state = createState();
    const scenario = SCENARIOS[route];
    for (const step of scenario.before ?? [])
      expect((await run(state, step)).status).toBeLessThan(300);
    const answer = await run(state, scenario.request);
    expect(answer.status, answer.body).not.toBe(501);
    expect(answer.status, answer.body).toBeLessThan(400);
    expect(contractProblems(route, answer)).toEqual([]);
  });

  it.each(ROUTES)("%s answers every contract error it may be asked for", async (route) => {
    for (const code of errorCodes(route)) {
      const answer = await send(createState(), ROUTE_TABLE[route].path, {
        method: ROUTE_TABLE[route].method,
        headers: { "x-lazni-greska": code },
      });
      expect(contractProblems(route, answer, code), code).toEqual([]);
    }
  });
});

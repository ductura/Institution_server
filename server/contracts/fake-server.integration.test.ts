import { request } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createFakeServer,
  FAKE_VECTOR_HEADER,
  ROUTE_TABLE,
  VECTORS,
  type FakeVector,
} from "./generated/fake-server/index.ts";
import { createClient } from "./generated/index.ts";
import { ROUTES } from "./index.ts";

const server = createFakeServer();
let port = 0;

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

type Reply = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

/** A raw HTTP request, so every header a vector names is sent as it is. */
function send(
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body: string | Buffer = "",
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          // A JPEG or DOCX answer (SRV-1102, SRV-1310) is compared in Base64, as the vector writes it.
          body: Buffer.concat(chunks).toString(
            res.headers["content-type"] === "image/jpeg" ||
              res.headers["content-type"] === "text/csv" ||
              res.headers["content-type"] === "application/pdf" ||
              String(res.headers["content-type"]).startsWith(
                "application/vnd.openxmlformats-officedocument.",
              )
              ? "base64"
              : "utf8",
          ),
        }),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

/** A multipart body (SRV-1102): a contentMediaType field is a file part, Base64 in the vector. */
function multipartOf(v: FakeVector, body: Record<string, string>): Buffer {
  const boundary = /boundary=([^;]+)/u.exec(v.request.headers?.["content-type"] ?? "")?.[1];
  const schema = ROUTES.find((r) => r.id === v.route)?.request.body as
    { properties?: Record<string, { contentMediaType?: string }> } | undefined;
  const parts = Object.entries(body).map(([name, value]) => {
    const type = schema?.properties?.[name]?.contentMediaType;
    const head =
      type === undefined
        ? `Content-Disposition: form-data; name="${name}"`
        : `Content-Disposition: form-data; name="${name}"; filename="isjecak.jpg"\r\nContent-Type: ${type}`;
    const bytes = type === undefined ? Buffer.from(value) : Buffer.from(value, "base64");
    return Buffer.concat([
      Buffer.from(`--${boundary}\r\n${head}\r\n\r\n`),
      bytes,
      Buffer.from("\r\n"),
    ]);
  });
  return Buffer.concat([...parts, Buffer.from(`--${boundary}--\r\n`)]);
}

function sendVector(v: FakeVector): Promise<Reply> {
  const route = ROUTE_TABLE[v.route as keyof typeof ROUTE_TABLE];
  const params = v.request.params ?? {};
  let path = route.path.replace(/\{(\w+)\}/g, (_, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );
  const query = new URLSearchParams(v.request.query ?? {}).toString();
  if (query) path += `?${query}`;
  const { body, rawBody } = v.request;
  const text =
    rawBody ??
    (body !== undefined && route.body === "multipart/form-data"
      ? multipartOf(v, body as Record<string, string>)
      : body === undefined
        ? ""
        : route.body === "application/x-www-form-urlencoded"
          ? new URLSearchParams(body as Record<string, string>).toString()
          : JSON.stringify(body));
  return send(route.method, path, { ...v.request.headers, [FAKE_VECTOR_HEADER]: v.name }, text);
}

// A content-length the body does not have (invalid, mismatched, cut short) is
// refused or waited on by Node itself; fake-server.test.ts covers those vectors.
const overHttp = VECTORS.filter((v) => v.request.headers?.["content-length"] === undefined);

describe("fake server over HTTP", () => {
  it("sends all but the framing vectors over the wire", () => {
    // Five framing vectors per guarded mutation route: 36 on main, +5 revision-requests, +25 enrolment, notice and work language, +40 institution;
    // the submission and the replay (DAN-818), as the evidence routes, have two each (timeout and bad-request);
    // the client context (DAN-846) has four (no session, so no unauthorized vector);
    // the client error (DAN-1568) has four, as the client context;
    // the three WebAuthn routes (DAN-840-1) have four each, framing only: timeout, length twice, stream;
    // teacher.assignment-submissions.post (DAN-903-1) five, as the fast path;
    // student.enrollments.post and student.notice-read.post (SRV-02) five each;
    // the four mutation routes of SRV-03 five each; student.submission-notes.post (SRV-19) five;
    // sources.lookup.post (SRV-7D) five, plus the work-source mutations (SRV-7C);
    // the detailed process summary (SRV-9D) adds five more.
    // public.verification.post (SRV-9B) four.
    // teacher.mentorship-request-decision.post (SRV-27) five.
    // work.consultation-records.post and work.consultation-additions.post (SRV-1105) five each.
    // student.source-proofs.post (SRV-1102) five.
    // teacher.deadline-extension.post (SRV-1108) five.
    // SRV-1105 has five framing vectors per mutation.
    // SRV-1104 has two content-length vectors per mutation.
    // teacher.merlin-packages.post (SRV-1110) five.
    // work.messages.post (SRV-1106) five.
    // work.milestones.patch (SRV-1103) five, teacher.working-criterion.put (SRV-1107) five.
    // student.assistant-request.post (SRV-1204) five.
    // work.direct-edit.put (SRV-1702) five.
    // Declaration save and upload have five framing vectors each.
    // F4-EDI-R20-SRV: work.comment-drafts-second.post five.
    // SRV-1703: work.comment-drafts.post, work.comment-draft.delete, work.comments.publish.post,
    // teacher.comment-bank.post, teacher.comment-bank.delete and work.review.post five each.
    // SRV-1407: the four mentorship request moves five each.
    // SRV-1408: five framing vectors each for the two membership writes.
    // SRV-1413: creating a mentor note has five framing vectors.
    // SRV-1701: five framing vectors for marking a notification read.
    // SRV-1601 adds five framing vectors for each of the three mutations.
    // SRV-1814: five framing vectors for the minimal problem report.
    // work.imports.post and work.imports.confirm.post (SRV-1803) five each.
    // teacher.assignment-copy.post (SRV-1904) five.
    // institution.config-versions.post (SRV-1406) five.
    // SRV-1903: the student's withdrawal and the teacher's switch five each.
    // student-work.start.post (SRV-1412) five.
    // SRV-1306: five framing vectors each for the three legal hold routes.
    // SRV-1308: five framing vectors each for the two student data export mutations.
    // work.event-disputes.post (SRV-1315) five.
    // institution.faculty-rules.post (SRV-2001) five.
    // SRV-1520: five framing vectors each for details, delete, submit, request-revision and approve.
    // SRV-1521: five framing vectors each for the milestone template PUT and the plan POST (add), and five for apply-template.
    // SRV-1530: work.interview-* have eight framing vectors in all (the bodies of five mutations).
    // SRV-V17-TEMPLATE-ADMIN: five framing vectors for the work template PUT.
    // SRV-V17-TEMPLATE-ASSIGN: five framing vectors for the assignment template PUT.
    // SRV-V17-FORMAT-RULES: a GET, so no framing vectors.
    // SRV-1606: five framing vectors for work.return-for-revision.post.
    // SRV-1230: work.assistant-match.post five.
    // PIL-P1-RITAM-SRV: work.input-rhythm.post, .delete and teacher.input-rhythm.put five each.
    // PIL-K-RAZGOVOR-SRV: work.interview-notes.post two.
    // INT-21 C: work.restore.post five.
    // PIL-K-IZJAVA-SRV: teacher.declaration-required.put five, submission.submit-second.post two (as submit).
    // work.comments.publish-selected.post five.
    // PIL-P1-RITAM-PREDMET-SRV: teacher.input-rhythm.delete and teacher.course-input-rhythm.put five each.
    // PIL-P1-PODUDARANJE-OBJASNJENJE-SRV: work.assistant-match-explanation.post five.
    // SRV-MENTOR-2: the five thesis writes (forms, setting, form state, consent, stage) five each.
    // SRV-V16-TEMA-PRIJEDLOG: work.thesis-topic.put and work.thesis-topic-decision.post five each.
    // SRV-V16-POVJERENSTVO-ZAPIS: work.thesis-committee.put five.
    // SRV-ED43-DORADA-POSALJI: collaboration.revision-send.post five.
    // SRV-IZJAVA-PITANJE: teacher.declaration-question.put five.
    // SRV-ADMIN-1: support.problem-report-status.post five.
    // SRV-ADMIN-2: institution.roster-imports.post and institution.roster-import-confirm.post five each.
    // SRV-V22-ISVU-POPIS: institution.isvu-roster-imports.post five.
    // SRV-MENTOR-1: mentorship.open.post, work.consultation-slot-requests.post,
    // work.consultation-slot-close.post, work.consultation-tasks.post and
    // work.consultation-task-mark.post five each.
    // SRV-MENTOR-3: work.self-note.put/.delete, work.reading-place.put/.delete and work.seen.post five each.
    // SRV-NF6-SIFRA: work.sealed-self-note.put/.delete and profile.self-note-key.put/.delete five each.
    // SRV-NF6-SIFRA-2: profile.self-note-key-checked.delete five.
    // SRV-KARTA-RASPON-RUTA: work.origin-segments.post five.
    // SRV-V17-RUBRIC-DEF: teacher.assignment-rubric.put five.
    // SRV-V17-RUBRIC-LEVEL: teacher.work-rubric-mark.put five.
    // SRV-V17-BANK-EDIT: teacher.comment-bank-entry.put five.
    // SRV-V19-DNEVNIK-UGOVOR: practice.placements.post, practice.entries.post and practice.signoffs.post five each.
    // SRV-V19-RECENZIJA-UGOVOR: peer-review.round.put, peer-review.allocate.post, peer-review.review-withdrawal.post and student.peer-review.post five each.
    // SRV-V19-GRUPA-UGOVOR: four mutating team routes five each.
    // SRV-NF4-KASNA-POLJE: institution.assignment-late-submission.put five.
    // SRV-ASIST-PREKIDAC: teacher.course-assistant.put five.
    // SRV-NF4-IZNIMKA-ZAPIS: teacher.late-exception.post five.
    // SRV-V15-UGOVOR: analysis.runs.post five.
    // SRV-V21-KOD-TESTOVI-RUTA: teacher.assignment-code-tests.put five.
    // SRV-ASIST-LIMIT-ADMIN: institution.assistant-request-limit.put five.
    // SRV-V18-KODIRANJE-GRADIVO: student.qual-materials.post and student.qual-material.delete five each.
    // SRV-V18-UPITNIK-AUTOR: teacher.questionnaires.post, teacher.questionnaire.patch and teacher.questionnaire-state.post five each.
    // SRV-V18-UPITNIK-ISPUNJAVANJE: student.questionnaire-responses.post and teacher.questionnaire-manual-responses.post five each.
    // SRV-V18-KODIRANJE-GRADIVO: student.qual-materials.post and student.qual-material.delete five each.
    // SRV-V18-KODIRANJE-SIFRARNIK: student.qual-codes.post, student.qual-code.patch and student.qual-code.delete five each.
    // SRV-V18-KODIRANJE-OZNAKE: student.qual-segments.post and student.qual-segment.delete five each.
    // SRV-ED42-PRIJEDLOZI: the four suggestion routes five each.
    // SRV-F4-PM2-R15: work.plan.put five.
    // F4-PM2-R08-SRV: student.accommodation.put five.
    // F4-PRE-R02-SRV: student.declaration-second.put five, as student.declaration.put.
    // F4-MEN-R09-SRV: mentorship.working-style.put five.
    expect(VECTORS.length - overHttp.length).toBe(945);
  });

  it.each(overHttp.map((v) => [`${v.route} ${v.name}`, v] as const))(
    "%s: exactly the vector",
    async (_, v) => {
      const res = await sendVector(v);
      const { status, contentType, headers = {}, body } = v.response;
      expect(res.status).toBe(status);
      for (const [name, value] of Object.entries(headers)) expect(res.headers[name]).toEqual(value);
      expect(res.headers["content-type"]).toBe(contentType);
      if (body === undefined) expect(res.body).toBe("");
      else if (contentType === "application/json") expect(JSON.parse(res.body)).toEqual(body);
      else expect(res.body).toBe(body);
    },
  );

  it.each([
    ["GET", "/api/v1/health?x=1", 501, "not_implemented"],
    ["POST", "/api/v1/profile/interface-locale", 501, "not_implemented"],
    ["DELETE", "/api/v1/health", 405, "method_not_allowed"],
    ["GET", "/api/v1/evidence/replay", 405, "method_not_allowed"],
    ["GET", "/api/v1/evidence/replay/extra", 404, "not_found"],
    ["GET", "/api/v1/evidence/commit", 405, "method_not_allowed"],
    ["GET", "/api/v1/health/extra", 404, "not_found"],
    ["GET", "/health", 404, "not_found"],
  ])("%s %s -> %i %s", async (method, path, status, code) => {
    const res = await send(method, path);
    expect(res.status).toBe(status);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(res.body)).toEqual({ error: code });
  });

  it("405 lists the allowed methods", async () => {
    const res = await send("PUT", "/api/v1/profile/interface-locale");
    expect(res.headers.allow).toBe("GET, POST");
  });

  it("answers 500 internal when it is picked, and the generated client knows the code", async () => {
    const pick = (async (url: URL, init: RequestInit) =>
      fetch(url, { ...init, headers: { [FAKE_VECTOR_HEADER]: "internal" } })) as typeof fetch;
    const call = createClient(`http://127.0.0.1:${port}`, pick);
    const none = { params: undefined, query: undefined, body: undefined };
    expect(await call("platform.health.get", none)).toEqual({
      ok: false,
      status: 500,
      code: "internal",
    });
  });

  it("the generated client reads the teacher's submissions of many assignments (DAN-903-1)", async () => {
    const route = "teacher.assignment-submissions.post";
    const vector = (name: string) => {
      const v = VECTORS.find((x) => x.route === route && x.name === name);
      if (v === undefined) throw new Error(`no vector ${name}`);
      return v;
    };
    // A browser sends the cookie and the origin itself; here the fetch adds them.
    const as = (name: string) =>
      createClient(`http://127.0.0.1:${port}`, (async (url: URL, init: RequestInit) =>
        fetch(url, {
          ...init,
          headers: { ...(init.headers as object), ...vector(name).request.headers },
        })) as typeof fetch);
    const ok = vector("submissions");
    expect(
      await as("submissions")(route, {
        params: undefined,
        query: undefined,
        body: ok.request.body as { assignmentIds: string[] },
      }),
    ).toEqual({ ok: true, status: 200, body: ok.response.body, headers: {} });
    const bad = vector("invalid-input");
    expect(
      await as("invalid-input")(route, {
        params: undefined,
        query: undefined,
        body: bad.request.body as { assignmentIds: string[] },
      }),
    ).toEqual({ ok: false, status: 422, code: "invalid_input" });
  });

  it("the generated client reads the teacher's access (DAN-903-2)", async () => {
    const route = "teacher.access.get";
    const vector = (name: string) => {
      const v = VECTORS.find((x) => x.route === route && x.name === name);
      if (v === undefined) throw new Error(`no vector ${name}`);
      return v;
    };
    const as = (name: string) =>
      createClient(`http://127.0.0.1:${port}`, (async (url: URL, init: RequestInit) =>
        fetch(url, {
          ...init,
          headers: { ...vector(name).request.headers, [FAKE_VECTOR_HEADER]: name },
        })) as typeof fetch);
    const none = { params: undefined, query: undefined, body: undefined };
    for (const name of ["allowed", "denied"])
      expect(await as(name)(route, none)).toEqual({
        ok: true,
        status: 200,
        body: vector(name).response.body,
        headers: {},
      });
    expect(await as("unauthorized")(route, none)).toEqual({
      ok: false,
      status: 401,
      code: "unauthorized",
    });
    expect(await as("unavailable")(route, none)).toEqual({
      ok: false,
      status: 503,
      code: "unavailable",
    });
  });

  it("the generated client reads the download manifest (DAN-931)", async () => {
    const route = "downloads.manifest.get";
    const vector = (name: string) => {
      const v = VECTORS.find((x) => x.route === route && x.name === name);
      if (v === undefined) throw new Error(`no vector ${name}`);
      return v;
    };
    const as = (name: string) =>
      createClient(`http://127.0.0.1:${port}`, (async (url: URL, init: RequestInit) =>
        fetch(url, { ...init, headers: { [FAKE_VECTOR_HEADER]: name } })) as typeof fetch);
    const none = { params: undefined, query: undefined, body: undefined };
    const ready = await as("ready")(route, none);
    expect(ready).toEqual({
      ok: true,
      status: 200,
      body: vector("ready").response.body,
      headers: {},
    });
    expect(ready.ok ? ready.body.packages.map((p) => `${p.system} ${p.architecture}`) : []).toEqual(
      ["macos arm64", "macos x64", "windows arm64", "windows x64"],
    );
    expect(await as("ready-empty")(route, none)).toEqual({
      ok: true,
      status: 200,
      body: { packages: [] },
      headers: {},
    });
    expect(await as("unavailable")(route, none)).toEqual({
      ok: false,
      status: 503,
      code: "unavailable",
    });
  });

  it("the generated client reads the state of each own work (DAN-989-1)", async () => {
    const route = "student.assignment-work.get";
    const vector = (name: string) => {
      const v = VECTORS.find((x) => x.route === route && x.name === name);
      if (v === undefined) throw new Error(`no vector ${name}`);
      return v;
    };
    const as = (name: string) =>
      createClient(`http://127.0.0.1:${port}`, (async (url: URL, init: RequestInit) =>
        fetch(url, {
          ...init,
          headers: { ...vector(name).request.headers, [FAKE_VECTOR_HEADER]: name },
        })) as typeof fetch);
    const none = { params: undefined, query: undefined, body: undefined };
    const ready = await as("ready")(route, none);
    expect(ready).toEqual({
      ok: true,
      status: 200,
      body: vector("ready").response.body,
      headers: {},
    });
    expect(ready.ok ? ready.body.assignments.map((row) => row.workState) : []).toEqual([
      "in_progress",
      "not_started",
      "submitted",
    ]);
    expect(await as("ready-empty")(route, none)).toEqual({
      ok: true,
      status: 200,
      body: { assignments: [] },
      headers: {},
    });
    for (const [name, status, code] of [
      ["signed-out", 401, "unauthorized"],
      ["unavailable", 503, "unavailable"],
    ] as const)
      expect(await as(name)(route, none)).toEqual({ ok: false, status, code });
  });

  it("the generated client reads when each own submission was confirmed (SRV-NF1-PREDANO)", async () => {
    const route = "student.assignment-submissions.get";
    const vector = (name: string) => {
      const v = VECTORS.find((x) => x.route === route && x.name === name);
      if (v === undefined) throw new Error(`no vector ${name}`);
      return v;
    };
    const as = (name: string) =>
      createClient(`http://127.0.0.1:${port}`, (async (url: URL, init: RequestInit) =>
        fetch(url, {
          ...init,
          headers: { ...vector(name).request.headers, [FAKE_VECTOR_HEADER]: name },
        })) as typeof fetch);
    const none = { params: undefined, query: undefined, body: undefined };
    const ready = await as("ready")(route, none);
    expect(ready).toEqual({
      ok: true,
      status: 200,
      body: vector("ready").response.body,
      headers: {},
    });
    expect(ready.ok ? ready.body.assignments.map((row) => row.afterDeadline) : []).toEqual([
      null,
      false,
      true,
    ]);
    expect(await as("ready-empty")(route, none)).toEqual({
      ok: true,
      status: 200,
      body: { assignments: [] },
      headers: {},
    });
    for (const [name, status, code] of [
      ["signed-out", 401, "unauthorized"],
      ["unavailable", 503, "unavailable"],
    ] as const)
      expect(await as(name)(route, none)).toEqual({ ok: false, status, code });
  });

  it("the generated client reads the student's own access log page by page (DAN-904)", async () => {
    const route = "student.access-log.get";
    const vector = (name: string) => {
      const v = VECTORS.find((x) => x.route === route && x.name === name);
      if (v === undefined) throw new Error(`no vector ${name}`);
      return v;
    };
    const as = (name: string) =>
      createClient(`http://127.0.0.1:${port}`, (async (url: URL, init: RequestInit) =>
        fetch(url, {
          ...init,
          headers: { ...vector(name).request.headers, [FAKE_VECTOR_HEADER]: name },
        })) as typeof fetch);
    const params = { documentId: "izmisljeni-rad-0001" };
    const first = await as("first-page")(route, { params, query: {}, body: undefined });
    expect(first).toEqual({
      ok: true,
      status: 200,
      body: vector("first-page").response.body,
      headers: {},
    });
    // The next page starts from the cursor the first one gave.
    const next = (first.ok ? first.body.next : null) ?? {};
    expect(await as("continued")(route, { params, query: next, body: undefined })).toEqual({
      ok: true,
      status: 200,
      body: vector("continued").response.body,
      headers: {},
    });
    for (const [name, status, code] of [
      ["not-found-or-not-the-owner", 404, "not_found"],
      ["unauthorized", 401, "unauthorized"],
    ] as const)
      expect(await as(name)(route, { params, query: {}, body: undefined })).toEqual({
        ok: false,
        status,
        code,
      });
  });

  it("a health check without a pick gets its success vector", async () => {
    const res = await send("GET", "/api/v1/health");
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: "ok" });
  });
});

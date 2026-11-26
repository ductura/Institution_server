// Load test "150 students submit in the last 10 minutes" (ops-opterecenje).
// SCENARIO AND SCRIPT ONLY: nothing here has been run against any environment
// (staging only after F4, owner decision). The target comes from the
// environment; there are no secrets and no real URLs in this file.
// Description, parameters and acceptance: docs/nalazi/ops-opterecenje.md.
//
//   k6 run -e BASE_URL=<server origin> -e SESSIONS_FILE=<json> \
//          docs/nalazi/ops-opterecenje/k6.ts
import crypto from "k6/crypto";
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

import { buildCommit, decodeBase64, sampleText, SUPPORTED_SCHEMA_VERSIONS } from "./segment.ts";

const BASE_URL = __ENV.BASE_URL; // origin of the server under test, e.g. the staging origin
const APP_ORIGIN = __ENV.APP_ORIGIN || BASE_URL; // value of the Origin header (APP_ORIGIN of the server)
const SESSIONS_FILE = __ENV.SESSIONS_FILE; // JSON: [{ "cookie": "<session value>", "assignmentId": "<uuid>" }, ...] (not in the repo)
const STUDENTS = Number(__ENV.STUDENTS || 150);
const WINDOW_SECONDS = Number(__ENV.WINDOW_SECONDS || 600);
const SAVES_PER_STUDENT = Number(__ENV.SAVES_PER_STUDENT || 6);
const COOKIE_NAME = __ENV.COOKIE_NAME || "__Host-ductus_session";

if (!BASE_URL || !SESSIONS_FILE) {
  fail("Set BASE_URL and SESSIONS_FILE (see docs/nalazi/ops-opterecenje.md).");
}

// Read in the init context; one entry per student, one VU per student.
const sessions = JSON.parse(open(SESSIONS_FILE));
if (sessions.length < STUDENTS) {
  fail(`SESSIONS_FILE has ${sessions.length} sessions, ${STUDENTS} needed.`);
}

const saveTime = new Trend("ops_save_ms", true);
const submitTime = new Trend("ops_submit_ms", true);
const openTime = new Trend("ops_open_ms", true);
const unsigned = new Rate("ops_receipt_not_signed");
const submitted = new Counter("ops_submitted");
const failed = new Counter("ops_student_failed");

// Metric names are snake_case in k6; kept out of object-literal keys for the lint rule.
const metric = (name: string): string => name;

export const options = {
  scenarios: {
    lastTenMinutes: {
      // Every student does exactly one pass; starts are spread over the first
      // minute so the open wave is not a single spike, then saves are paced
      // across the window and the submit lands in its last part.
      executor: "per-vu-iterations",
      vus: STUDENTS,
      iterations: 1,
      maxDuration: `${Math.ceil(WINDOW_SECONDS * 1.5)}s`,
    },
  },
  thresholds: {
    // Assumed limits (the plan names p95 and errors, not values): see "Pretpostavke".
    [metric("ops_save_ms")]: ["p(95)<1500"],
    [metric("ops_submit_ms")]: ["p(95)<3000"],
    [metric("ops_open_ms")]: ["p(95)<2000"],
    [metric("ops_receipt_not_signed")]: ["rate<0.01"],
    [metric("http_req_failed")]: ["rate<0.01"],
    [metric("ops_student_failed")]: ["count==0"],
  },
};

const sha256Hex = (text) => crypto.sha256(text, "hex");

function headers(cookie) {
  return {
    "Content-Type": "application/json",
    cookie: `${COOKIE_NAME}=${cookie}`,
    origin: APP_ORIGIN,
    "Sec-Fetch-Site": "same-origin",
    "Ductus-Protocol": "1",
  };
}

function post(path, body, cookie, tag) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headers(cookie),
    tags: { name: tag },
  });
}

export default function () {
  const index = __VU - 1;
  const { cookie, assignmentId } = sessions[index];
  const student = `s${String(__VU).padStart(3, "0")}`;
  const t0 = Date.now();

  // Start spread over the first 60 s.
  sleep((index / STUDENTS) * 60);

  const opened = post(
    "/api/v1/evidence/open",
    { assignmentId, start: true },
    cookie,
    "evidence.open",
  );
  openTime.add(opened.timings.duration);
  if (!check(opened, { "open 200": (r) => r.status === 200 })) {
    failed.add(1);
    return;
  }
  const o = opened.json();
  const document = JSON.parse(decodeBase64(o.document));
  // The builder emits ductus-edit-steps-v1, which only works of document version 1 or 2 take.
  if (!SUPPORTED_SCHEMA_VERSIONS.includes(document.schemaVersion)) {
    console.error(
      `student ${student}: document version ${document.schemaVersion} is not supported by this script`,
    );
    failed.add(1);
    return;
  }
  let state = {
    documentId: o.documentId,
    evidenceProfileId: o.evidenceProfileId,
    revision: o.currentRevision,
    document,
    headSegmentHash: o.headSegmentHash,
    lastSequenceTo: o.lastSequenceTo,
    sessionId: `lt-${student}-${t0}`,
  };

  // Saves at absolute targets (seconds from this student's start), each inside its own
  // slot of the span 60 s .. WINDOW-90 s, so jitter never accumulates; the submit
  // lands in WINDOW-60 s .. WINDOW-10 s. Late responses shorten the next wait, not the plan.
  const slot = (WINDOW_SECONDS - 150) / SAVES_PER_STUDENT;
  const waitUntil = (target: number): void => sleep(Math.max(0, target - (Date.now() - t0) / 1000));
  for (let n = 1; n <= SAVES_PER_STUDENT; n += 1) {
    waitUntil(60 + (n - 1 + 0.05 + Math.random() * 0.9) * slot);
    const built = buildCommit(
      state,
      sampleText(student, n),
      Date.now(),
      sha256Hex,
      `lt-${student}`,
    );
    const res = post("/api/v1/evidence/commit", built.body, cookie, "evidence.commit");
    saveTime.add(res.timings.duration);
    const ok = check(res, { "commit 200": (r) => r.status === 200 });
    if (!ok) {
      failed.add(1);
      return;
    }
    const c = res.json();
    unsigned.add(!(c.receipt && c.receipt.status === "signed"));
    state = {
      ...built.next,
      revision: c.revision,
      headSegmentHash: c.receipt?.signedReceipt?.payload?.segmentHash ?? built.segmentHash,
    };
  }

  // Submit in the last part of the window.
  waitUntil(WINDOW_SECONDS - 60 + Math.random() * 50);
  const sent = post(
    "/api/v1/submission/v2",
    { documentId: state.documentId, revision: state.revision },
    cookie,
    "submission.submit-second",
  );
  submitTime.add(sent.timings.duration);
  if (check(sent, { "submit 200": (r) => r.status === 200 })) submitted.add(1);
  else failed.add(1);
}

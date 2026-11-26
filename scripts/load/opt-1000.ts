// SRV-OPT-1000 (DAN-895): two separate k6 loads on the base of ISTR-9
// (scenarij.ts). Never started on a stack in use; the owner approves every
// real run (docs/nalazi/srv-opt-1000.md). Locally only the dry run with 10 users.
//
//   k6 run -e OPTEREĆENJE=pisci   -e PODACI=<abs>/r1.json -e IZVOR=<origin> -e OZNAKA=pisci-w1-r1 scripts/load/opt-1000.ts
//   k6 run -e OPTEREĆENJE=zahtjevi -e PODACI=<abs>/r1.json -e IZVOR=<origin> -e STOPA=1000 -e OZNAKA=zahtjevi-w1-r1 scripts/load/opt-1000.ts
//
// pisci: every prepared student writes, one save every 15 to 30 s; a tenth of
//   them lose the connection once and resend the save they were not sure of
//   (answer `duplicate` is right), then submit through submission/v2.
// zahtjevi: an arrival rate of STOPA requests a second (constant-arrival-rate,
//   so a slow server cannot slow the generator), reads only: the list of
//   assignments and the open of the work.
// ZAGLAVLE=1 adds a distinct X-Forwarded-For per student (needs the generator
// address in TRUSTED_PROXIES of the server under test); without it all traffic
// is one client IP and the per-IP limits answer 429.
// The summary (p50, p95, p99 per route, errors) goes to IZLAZ if it is set.

import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import http from "k6/http";

import {
  forwardedFor,
  LOADS,
  maxDurationSeconds,
  RESEND_SHARE,
  SAVE_GAP_S,
} from "./opt-1000-plan.ts";

const env =
  (globalThis as unknown as Record<string, Record<string, string | undefined>>)["__ENV"] ?? {};

type Commit = { clientTransactionId: string; baseRevision: number };
type Student = { cookie: string; assignmentId: string; documentId: string; commits: Commit[] };

const load = env["OPTEREĆENJE"] ?? "";
if (!(LOADS as readonly string[]).includes(load))
  throw new Error("OPTEREĆENJE must be pisci or zahtjevi");
const origin = env.IZVOR ?? "http://localhost:4000";
const forwarded = env.ZAGLAVLE === "1";
const students = new SharedArray<Student>("studenti", () => {
  const path = env.PODACI;
  if (path === undefined) throw new Error("PODACI (prepared students) is required");
  return JSON.parse(open(path)) as Student[];
});
if (students.length === 0) throw new Error("no prepared students: nothing would be measured");

const REQUEST_TIMEOUT_S = 30;
const rate = Number(env.STOPA ?? "1000");
const duration = Number(env.TRAJANJE_S ?? "120");
if (load === "zahtjevi" && (!Number.isSafeInteger(rate) || rate < 1 || rate > 1_000))
  throw new Error("STOPA must be 1 to 1000");
if (!Number.isSafeInteger(duration) || duration < 1 || duration > 3_600)
  throw new Error("TRAJANJE_S must be 1 to 3600");
const longestChain = Math.max(...Array.from(students, (student) => student.commits.length));

const FAILED = "http_req_failed";
const DROPPED = "dropped_iterations";
const ROUTES: Record<string, string[]> = {
  pisci: ["commit", "submission"],
  zahtjevi: ["assignments", "open"],
};
const writers = {
  executor: "per-vu-iterations",
  vus: students.length,
  iterations: 1,
  maxDuration: `${maxDurationSeconds(longestChain)}s`,
};
const requests = {
  executor: "constant-arrival-rate",
  rate,
  timeUnit: "1s",
  duration: `${duration}s`,
  preAllocatedVUs: Math.min(rate * 2, 2_000),
  maxVUs: Math.min(rate * 4, 4_000),
};

export const options = {
  scenarios: { [load]: load === "pisci" ? writers : requests },
  // Any failed request or check ends k6 with a non-zero code, as in ISTR-9.
  thresholds: {
    [FAILED]: ["rate==0"],
    checks: ["rate==1"],
    // A dropped arrival means the server was not tested at the asked rate.
    ...(load === "zahtjevi" ? { [DROPPED]: ["count==0"] } : {}),
    // Never failing; they only make k6 keep p50/p95/p99 per route in the summary.
    ...Object.fromEntries(
      (ROUTES[load] ?? []).map((name) => [`http_req_duration{name:${name}}`, ["max>=0"]]),
    ),
  },
  summaryTrendStats: ["p(50)", "p(95)", "p(99)", "max", "count"],
};

const between = (low: number, high: number): number => low + Math.random() * (high - low);

function headersOf(student: Student, index: number): Record<string, string> {
  const headers: Record<string, string> = {
    cookie: student.cookie,
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "ductus-protocol": "1",
  };
  if (forwarded) headers["x-forwarded-for"] = forwardedFor(index);
  return headers;
}

function get(student: Student, index: number, path: string, name: string) {
  return http.get(`${origin}/api/v1/${path}`, {
    headers: headersOf(student, index),
    tags: { name },
    timeout: `${REQUEST_TIMEOUT_S}s`,
  });
}

function post(student: Student, index: number, path: string, body: unknown, name: string) {
  const headers = headersOf(student, index);
  return http.post(`${origin}/api/v1/${path}`, JSON.stringify(body), {
    headers,
    tags: { name },
    timeout: `${REQUEST_TIMEOUT_S}s`,
  });
}

function save(student: Student, index: number, commit: Commit, expected: string): boolean {
  const response = post(student, index, "evidence/commit", commit, "commit");
  return check(response, {
    "spremanje 200": (r) => r.status === 200,
    [`spremanje ${expected}`]: (r) =>
      r.status === 200 && (r.json() as { status?: string }).status === expected,
  });
}

function writer(): void {
  const index = execution.vu.idInTest - 1;
  const student = students[index];
  if (student === undefined) throw new Error("more VUs than prepared students");
  sleep(between(0, SAVE_GAP_S[0]));
  const resendAt =
    Math.random() < RESEND_SHARE ? Math.floor(Math.random() * student.commits.length) : -1;
  for (const [position, commit] of student.commits.entries()) {
    if (!save(student, index, commit, "committed")) return;
    // The answer was lost: the client cannot know, so it sends the same save again.
    if (position === resendAt && !save(student, index, commit, "duplicate")) return;
    sleep(between(SAVE_GAP_S[0], SAVE_GAP_S[1]));
  }
  const last = student.commits.at(-1);
  if (last === undefined) return;
  const response = post(
    student,
    index,
    "submission/v2",
    { documentId: student.documentId, revision: last.baseRevision + 1 },
    "submission",
  );
  check(response, {
    "predaja submitted": (r) =>
      r.status === 200 && (r.json() as { status?: string }).status === "submitted",
  });
}

function reader(): void {
  const index = (execution.scenario.iterationInTest as number) % students.length;
  const student = students[index];
  if (student === undefined) throw new Error("no prepared student");
  if (index % 10 < 7) {
    const response = get(student, index, "student/assignments", "assignments");
    check(response, { "popis 200": (r) => r.status === 200 });
  } else {
    const response = post(
      student,
      index,
      "evidence/open",
      { assignmentId: student.assignmentId, start: true },
      "open",
    );
    check(response, { "otvaranje 200": (r) => r.status === 200 });
  }
}

export default function (): void {
  if (load === "pisci") writer();
  else reader();
}

type Summary = { metrics: Record<string, { values: Record<string, number> } | undefined> };

export function handleSummary(data: Summary): Record<string, string> {
  const out = env.IZLAZ;
  const picked: Record<string, unknown> = { oznaka: env.OZNAKA ?? "", opterecenje: load };
  for (const [name, metric] of Object.entries(data.metrics))
    if (
      name.startsWith("http_req_duration") ||
      name === FAILED ||
      name === "http_reqs" ||
      name === DROPPED
    )
      picked[name] = metric?.values;
  return out === undefined ? {} : { [out]: JSON.stringify(picked, null, 2) };
}

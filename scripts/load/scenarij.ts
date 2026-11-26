// ISTR-9: k6 load scenarios against a separate local stack. Run with the k6
// binary (a local tool, never a dependency), one heavy run at a time:
//
//   k6 run -e SCENARIJ=rok -e PODACI=<abs path>/.local/load/r1.json scripts/load/scenarij.ts
//
// SCENARIJ: nastava (saves spread over minutes), rok (everyone saves fast and
// submits), sinkronizacija (everyone reconnects at once, sends the queued saves
// back to back and repeats the last one). The number of users is the number of
// students priprema.ts prepared. Thresholds make any failed request or check
// end k6 with a non-zero code, so a stopped server is never a silent pass.

import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import execution from "k6/execution";
import http from "k6/http";

// k6 puts the -e variables on the global object, under the name __ENV.
const env =
  (globalThis as unknown as Record<string, Record<string, string | undefined>>)["__ENV"] ?? {};

type Commit = { clientTransactionId: string; baseRevision: number };
type Student = { cookie: string; documentId: string; commits: Commit[] };

const scenario = env.SCENARIJ ?? "";
if (!["nastava", "rok", "sinkronizacija"].includes(scenario))
  throw new Error("SCENARIJ must be nastava, rok or sinkronizacija");
const origin = env.IZVOR ?? "http://localhost:4000";
const students = new SharedArray<Student>("studenti", () => {
  const path = env.PODACI;
  if (path === undefined) throw new Error("PODACI (prepared students) is required");
  return JSON.parse(open(path)) as Student[];
});
if (students.length === 0) throw new Error("no prepared students: nothing would be measured");

// Seconds a student waits before the first save and between saves.
const PACING: Record<string, { start: number; gap: readonly [number, number] }> = {
  nastava: { start: 30, gap: [5, 15] },
  rok: { start: 5, gap: [0.5, 1.5] },
  sinkronizacija: { start: 0, gap: [0, 0] },
};
const pacing = PACING[scenario] ?? { start: 0, gap: [0, 0] };
const REQUEST_TIMEOUT_S = 30;
// The run may last as long as the slowest student could: the longest start,
// every pause at its longest and every request (the saves plus the closing
// submission or repeat) at its timeout, plus a minute.
const longestChain = Math.max(...Array.from(students, (student) => student.commits.length));
const maxDurationS = Math.ceil(
  pacing.start + longestChain * pacing.gap[1] + (longestChain + 1) * REQUEST_TIMEOUT_S + 60,
);

// k6 metric name: any failed request fails the run.
const FAILED = "http_req_failed";

export const options = {
  scenarios: {
    [scenario]: {
      executor: "per-vu-iterations",
      vus: students.length,
      iterations: 1,
      maxDuration: `${maxDurationS}s`,
    },
  },
  thresholds: { [FAILED]: ["rate==0"], checks: ["rate==1"] },
  summaryTrendStats: ["p(50)", "p(95)", "max", "count"],
};

const between = (low: number, high: number): number => low + Math.random() * (high - low);

function post(student: Student, path: string, body: unknown, name: string) {
  return http.post(`${origin}/api/v1/${path}`, JSON.stringify(body), {
    headers: {
      cookie: student.cookie,
      origin,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "ductus-protocol": "1",
    },
    tags: { name },
    timeout: `${REQUEST_TIMEOUT_S}s`,
  });
}

/** Sends one save; false stops this student, as a later save cannot follow a lost one. */
function save(student: Student, commit: Commit, expected: "committed" | "duplicate"): boolean {
  const response = post(student, "evidence/commit", commit, "commit");
  const ok = check(response, {
    "spremanje 200": (r) => r.status === 200,
    [`spremanje ${expected}`]: (r) =>
      r.status === 200 && (r.json() as { status?: string }).status === expected,
  });
  return ok;
}

export default function (): void {
  const student = students[execution.vu.idInTest - 1];
  if (student === undefined) throw new Error("more VUs than prepared students");
  sleep(between(0, pacing.start));
  for (const commit of student.commits) {
    if (!save(student, commit, "committed")) return;
    sleep(between(pacing.gap[0], pacing.gap[1]));
  }
  const last = student.commits.at(-1);
  if (scenario === "sinkronizacija" && last !== undefined && !save(student, last, "duplicate"))
    return;
  if (scenario === "rok" && last !== undefined) {
    const response = post(
      student,
      "submission",
      { documentId: student.documentId, revision: last.baseRevision + 1 },
      "submission",
    );
    check(response, {
      "predaja submitted": (r) =>
        r.status === 200 && (r.json() as { status?: string }).status === "submitted",
    });
  }
}

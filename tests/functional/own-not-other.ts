// S-1H.3 (DAN-1003): over dist/server.js on the VS-1 stack, student A opens,
// commits and replays their own work, and on the work of B, a classmate on the
// same assignment, the same three routes answer A exactly as for a work that
// does not exist: the contract's 404 {"status":"not_found"}. The output names
// the revision of the checkout and of the running stack. Local stack and CI only (`pnpm build && pnpm
// stack:vs1 up` first):
//   pnpm test:functional
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { type Answer, commitRequest, post } from "../../scripts/stack/index.ts";

import { notFoundProblem } from "./not-found.ts";
import { acknowledgeNotice, runningStack, seedCourse, seedStudent, type Student } from "./stack.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const OPEN = "/api/v1/evidence/open";
const COMMIT = "/api/v1/evidence/commit";
const REPLAY = "/api/v1/evidence/replay";
/** Every answer the check reads; fewer means it stopped early or skipped one. */
export const CHECKS = 11;

/** The whole check against the stack in `stackDir`; returns the revision line, throws on the first broken promise. */
export async function check(stackDir: string): Promise<string> {
  const { state, run } = runningStack(stackDir, ROOT);
  console.log(`S-1H.3 over ${run}`);
  const { server, postgres } = state.ports;
  let checked = 0;
  const as = (student: Student, route: string, body: unknown) =>
    post(server, route, body, student.token);
  /** A success: 200 and every field of `expected`. */
  const succeeded = (route: string, answer: Answer, expected: Record<string, unknown>) => {
    checked += 1;
    const wrong = Object.entries(expected).some(([key, value]) => answer.body[key] !== value);
    if (answer.status !== 200 || wrong) {
      throw new Error(`${route} answered ${answer.status}, not 200 ${JSON.stringify(expected)}`);
    }
  };
  /** A over B's work: every answer must be the contract's not_found; all that are not fail the test. */
  const notFound = (answers: readonly (readonly [string, Answer])[]) => {
    checked += answers.length;
    const failed = answers.map(([route, answer]) => notFoundProblem(route, answer));
    const problems = failed.filter((problem) => problem !== null);
    if (problems.length > 0) throw new Error(`A over B's work: ${problems.join("; ")}`);
  };

  // A and B are classmates on assignment Z, each with a work of their own; B
  // alone is also in course Y, whose notice A has acknowledged, so A lacks
  // only the membership. All in demo-fakultet, so no institution filter helps.
  const z = seedCourse(stackDir, postgres);
  const y = seedCourse(stackDir, postgres);
  const a = seedStudent(stackDir, postgres, [z]);
  const b = seedStudent(stackDir, postgres, [z, y]);
  acknowledgeNotice(stackDir, postgres, a, y);

  // B's work on Z, opened and not committed: the commit below is one B could make now.
  const opened = await as(b, OPEN, { assignmentId: z.assignmentId, start: true });
  succeeded(OPEN, opened, { status: "opened" });
  // A has a work of their own on Z before any attempt, so no rule of the form
  // "a work on the same assignment" can let A through unseen.
  const own = await as(a, OPEN, { assignmentId: z.assignmentId, start: true });
  succeeded(OPEN, own, { status: "opened" });
  if (own.body.documentId === opened.body.documentId) throw new Error("A opened B's document");
  const commit = commitRequest(opened.body, `tx-${randomBytes(4).toString("hex")}`);
  const work = { documentId: opened.body.documentId, from: 0 };
  notFound([
    [OPEN, await as(a, OPEN, { assignmentId: y.assignmentId, start: true })],
    [COMMIT, await as(a, COMMIT, commit)],
    [REPLAY, await as(a, REPLAY, work)],
  ]);

  // Control: B sends the very same commit and it is new (committed, revision
  // 1, not duplicate), so A's request was valid and recorded nothing; B reads
  // the one segment and A still cannot; Y is open to its member.
  succeeded(COMMIT, await as(b, COMMIT, commit), { status: "committed", revision: 1 });
  succeeded(REPLAY, await as(b, REPLAY, work), { segmentCount: 1 });
  notFound([[REPLAY, await as(a, REPLAY, work)]]);
  succeeded(OPEN, await as(b, OPEN, { assignmentId: y.assignmentId, start: true }), {
    status: "opened",
  });

  // A's own work on Z, opened above as a document other than B's: commit and replay succeed.
  const mine = commitRequest(own.body, `tx-${randomBytes(4).toString("hex")}`);
  succeeded(COMMIT, await as(a, COMMIT, mine), { status: "committed", revision: 1 });
  succeeded(REPLAY, await as(a, REPLAY, { documentId: own.body.documentId, from: 0 }), {
    segmentCount: 1,
  });
  if (checked !== CHECKS) throw new Error(`${checked} answers checked, not ${CHECKS}`);
  return run;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.VS1_STACK_DIR ?? join(ROOT, ".stack", "vs1");
  check(dir).then(
    (run) => console.log(`S-1H.3 own work yes, other's no: ${CHECKS} answers passed over ${run}`),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "failed";
      console.error(`S-1H.3 own work yes, other's no: ${message}`);
      process.exitCode = 1;
    },
  );
}

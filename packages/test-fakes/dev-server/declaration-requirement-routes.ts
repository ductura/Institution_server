// The declaration requirement on the dev fake server (PIL-K-IZJAVA-SRV,
// declaration-v1 §6.7): only the teacher of the assignment's course reads and
// sets it, off by default. While it is on, the checked submission
// (submission.submit-checked.post) answers 409 declaration_required unless the
// student's declaration is confirmed for the current revision; otherwise it is
// the fake's submission.submit.post. The real rule is declaration.pin_request
// and institution.set_declaration_required (20261214110000). The switch lives
// in memory beside the state.
import type { Operations } from "../../contracts/index.ts";
import { EVIDENCE_HANDLERS } from "./evidence-routes.ts";
import type { Context, Handlers } from "./server.ts";
import { STATEMENT_HANDLERS } from "./statement-routes.ts";
import { teachesCourse, type Account, type State } from "./state.ts";

type Requirement = Operations["teacher.declaration-requirement.get"]["success"]["body"];
const REQUIREMENTS = new WeakMap<State, Map<string, Requirement>>();
const DEFAULT: Requirement = { required: false, changedAt: null };

function requirementsOf(state: State): Map<string, Requirement> {
  const map = REQUIREMENTS.get(state) ?? new Map<string, Requirement>();
  REQUIREMENTS.set(state, map);
  return map;
}

function taught(state: State, account: Account | null, assignmentId: string): string | null {
  const assignment = state.assignments.find((a) => a.id === assignmentId);
  const course = state.courses.find((c) => c.id === assignment?.courseId);
  return assignment !== undefined &&
    course !== undefined &&
    account !== null &&
    teachesCourse(course, account)
    ? assignment.id
    : null;
}

/** Whether the caller's declaration is confirmed for the revision of the work, as the fake reads it. */
function confirmed(ctx: Context<"submission.submit-checked.post">, assignmentId: string): boolean {
  const read = STATEMENT_HANDLERS["student.declaration.get"]!({
    ...ctx,
    params: { assignmentId },
    query: undefined,
    body: undefined,
  } as unknown as Context<"student.declaration.get">);
  return "status" in read && read.status === 200 && read.body.state === "confirmed";
}

export const DECLARATION_REQUIREMENT_HANDLERS: Handlers = {
  "teacher.declaration-requirement.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    return { status: 200, body: requirementsOf(state).get(assignmentId) ?? DEFAULT };
  },
  "teacher.declaration-requirement.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const assignmentId = taught(state, account, params.assignmentId);
    if (assignmentId === null) return { error: "not_found" };
    const current = requirementsOf(state).get(assignmentId) ?? DEFAULT;
    if (current.required === body.required) return { status: 200, body: current };
    const next: Requirement = { required: body.required, changedAt: now.toISOString() };
    requirementsOf(state).set(assignmentId, next);
    return { status: 200, body: next };
  },
  "submission.submit-checked.post": (ctx) => {
    const work = ctx.state.works.find(
      (w) => w.documentId === ctx.body.documentId && w.studentId === ctx.account?.id,
    );
    if (
      work !== undefined &&
      work.submittedAt === null &&
      requirementsOf(ctx.state).get(work.assignmentId)?.required === true &&
      !confirmed(ctx, work.assignmentId)
    ) {
      return { error: "declaration_required" };
    }
    return EVIDENCE_HANDLERS["submission.submit.post"]!(
      ctx as unknown as Context<"submission.submit.post">,
    ) as ReturnType<NonNullable<Handlers["submission.submit-checked.post"]>>;
  },
};

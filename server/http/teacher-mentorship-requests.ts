import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import type { ActorTransaction } from "../database/index.ts";
import { liveSessionTokenFromCookie } from "../session/index.ts";

import type { Databases } from "./databases.ts";
import { reportServerError } from "./error-catalog.ts";
import { INSTITUTION_BODY_TIMEOUT_MS, readInstitutionJson } from "./institution-courses.ts";
import { sendProblem } from "./problem.ts";
import { requestIdOf } from "./request-id.ts";
import { type Route, sendJson } from "./router.ts";

const LIST = ROUTES.find((route) => route.id === "teacher.mentorship-requests.get")!;
const DECIDE = ROUTES.find((route) => route.id === "teacher.mentorship-request-decision.post")!;
const LIST_BODY = LIST.responses[0]!.body!;
const DECISION_BODY = DECIDE.request.body!;
const DECISION_ANSWER = DECIDE.responses[0]!.body!;

// The request RLS also lets a student read their outgoing requests. The
// teacher predicate below only selects incoming ones. An empty result row
// (as opposed to an empty list) means there is no session actor.
// There is no name reader for this relationship in SRV-28. The app role
// cannot read identity.person_name, so the response uses the contract's null.
const LIST_SQL = `
SELECT COALESCE(
  jsonb_agg(jsonb_build_object(
    'requestId', r.id,
    'student', NULL::jsonb,
    'workType', r.work_type,
    'requestedAt', to_char(r.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) ORDER BY r.requested_at DESC, r.id) FILTER (WHERE r.id IS NOT NULL),
  '[]'::jsonb
) AS requests
FROM app.current_actor() actor
LEFT JOIN institution.mentorship_request r
  ON r.teacher_id = actor.user_id AND r.institution_id = actor.institution_id
 AND r.withdrawn_at IS NULL AND r.approved_at IS NULL AND r.declined_at IS NULL
WHERE actor.user_id IS NOT NULL AND actor.institution_id IS NOT NULL
GROUP BY actor.user_id, actor.institution_id`;

const OWN_REQUEST = `FROM institution.mentorship_request r
 WHERE r.id = $1::uuid AND r.teacher_id = app.current_user_id()
   AND r.institution_id = app.current_institution_id()
   AND r.withdrawn_at IS NULL AND r.approved_at IS NULL AND r.declined_at IS NULL`;
const LOCK_APPROVAL_SQL = `
SELECT pg_advisory_xact_lock(hashtextextended(
  'institution.mentorship_request:' || r.institution_id || ':' || r.student_id || ':' || r.work_type, 0))
${OWN_REQUEST}`;
const OPEN_SQL = `SELECT EXISTS (SELECT 1 ${OWN_REQUEST}) AS open`;

type Decision =
  | { requestId: string; decision: "approve" }
  | { requestId: string; decision: "decline"; reason?: string };

class DecisionConflict extends Error {}

async function decide(tx: ActorTransaction, input: Decision) {
  const id = input.requestId.toLowerCase();
  if (input.decision === "decline") {
    const {
      rows: [row],
    } = await tx.query(
      "SELECT institution.decline_mentorship_request($1::uuid, $2::text) AS result",
      [id, input.reason ?? null],
    );
    if (row?.result === false) throw new DecisionConflict();
    if (row?.result !== true) throw new Error("invalid decline result");
    return { decision: "decline" };
  }

  // The RPC is idempotent for existing approvals. Reuse its transaction lock
  // and read again after acquiring it, in a fresh READ COMMITTED snapshot.
  // The RPC still authorizes the caller and checks the row under its own lock.
  const locked = await tx.query(LOCK_APPROVAL_SQL, [id]);
  const open = locked.rowCount === 1 && (await tx.query(OPEN_SQL, [id])).rows[0]?.open === true;
  const {
    rows: [row],
  } = await tx.query("SELECT institution.approve_mentorship_request($1::uuid) AS result", [id]);
  // Roll back if a request became visible after the lock lookup and the RPC
  // created a mentorship we could not classify as a first approval.
  if (!open) throw new DecisionConflict();
  return { decision: "approve", mentorshipId: row?.result };
}

const REFUSALS: ReadonlyMap<unknown, readonly [number, string]> = new Map([
  ["ZD401", [401, "unauthorized"]],
  ["ZD403", [403, "forbidden"]],
  ["ZD409", [409, "conflict"]],
  ["ZD422", [422, "invalid_input"]],
]);

export function createTeacherMentorshipRequestRoutesFor(
  main: Pick<Databases["main"], "withActor">,
): Route[] {
  return [
    {
      contract: LIST,
      async handle(request, response) {
        const site = request.headersDistinct["sec-fetch-site"];
        if (site !== undefined && (site.length !== 1 || site[0] !== "same-origin")) {
          return sendProblem(response, 403, "forbidden");
        }
        const token = liveSessionTokenFromCookie(request.headers.cookie);
        if (token === undefined) return sendProblem(response, 401, "unauthorized");
        try {
          const row = await main.withActor(token, async (tx) => (await tx.query(LIST_SQL)).rows[0]);
          if (row === undefined) return sendProblem(response, 401, "unauthorized");
          const body = { requests: row.requests };
          if (!Value.Check(LIST_BODY, body)) throw new Error("invalid mentorship request list");
          sendJson(response, 200, body);
        } catch (error) {
          reportServerError("route", error, requestIdOf(response), LIST.id);
          sendProblem(response, 503, "unavailable");
        }
      },
    },
    {
      contract: DECIDE,
      async handle(request, response) {
        const input = await readInstitutionJson(
          request,
          response,
          [],
          DECIDE.request.maxBodyBytes!,
          INSTITUTION_BODY_TIMEOUT_MS,
        );
        if (input === null) return;
        if (!Value.Check(DECISION_BODY, input.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        const decision = input.value as Decision;
        try {
          const body = await main.withActor(input.token, async (tx) => {
            const answer = await decide(tx, decision);
            if (!Value.Check(DECISION_ANSWER, answer)) throw new Error("invalid decision result");
            return answer;
          });
          sendJson(response, 200, body);
        } catch (error) {
          if (error instanceof DecisionConflict) return sendProblem(response, 409, "conflict");
          const refusal = REFUSALS.get(
            typeof error === "object" && error !== null && "code" in error ? error.code : undefined,
          );
          if (refusal !== undefined) return sendProblem(response, ...refusal);
          reportServerError("route", error, requestIdOf(response), DECIDE.id);
          sendProblem(response, 503, "unavailable");
        }
      },
    },
  ];
}

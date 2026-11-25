// SRV-V19-GRUPA-RUTE (Ductus#2055; val 19): the nine routes of the work teams
// (server/contracts/routes/work-team.ts, docs/contracts/work-team-v1.md). The
// handler checks the shape; the database decides who may do what from the
// relation (student enrolled, teacher of the course) and answers another's, an
// unknown and a malformed assignment or team with the same 404 (C-23). Nothing
// here grades, ranks or sanctions: the contribution is one answer, in the order
// of the names, with the permanent notice that it is not evidence of authorship,
// and no other route carries it.
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../../contracts/index.ts";
import {
  createWorkTeamStore,
  type ContributionSource,
  type WithActor,
} from "../../database/index.ts";
import { liveSessionTokenFromCookie, recordActivity } from "../../session/index.ts";

import {
  parseJson,
  readBodyWithLimit,
  refuse,
  reportServerError,
  requestIdOf,
  sendJson,
  sendProblem,
  type Route,
} from "../index.ts";

const route = (id: string) => ROUTES.find((candidate) => candidate.id === id)!;
const settingPut = route("institution.assignment-team-setting.put");
const settingGet = route("institution.assignment-team-setting.get");
const studentTeamGet = route("student.work-team.get");
const studentTeamPost = route("student.work-team.post");
const teacherTeamsGet = route("teacher.work-teams.get");
const teacherTeamsPost = route("teacher.work-teams.post");
const teacherMemberPost = route("teacher.work-team-member.post");
const studentContributionGet = route("student.work-team-contribution.get");
const teacherContributionGet = route("teacher.work-team-contribution.get");
const JSON_MEDIA_TYPE = /^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?$/iu;
const BODY_TIMEOUT_MS = 5_000;

type Json = Record<string, unknown>;

function codeOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
}

/** The problem a refusal of the database becomes, or undefined for a failure (503). */
function refusalOf(error: unknown): readonly [number, string] | undefined {
  switch (codeOf(error)) {
    case "ZD401":
      return [401, "unauthorized"];
    case "ZD404":
      return [404, "not_found"];
    case "ZD422":
      return [422, "invalid_input"];
    case "ZD409":
      return [409, "conflict"];
    default:
      return undefined;
  }
}

export function createWorkTeamRoutesFor(
  { withActor }: { withActor: WithActor },
  /** Off until SRV-1222 gives the stored records; then the contribution reads them. */
  contributionSource?: ContributionSource,
): Route[] {
  const store = createWorkTeamStore(withActor, contributionSource);
  const contracts = [
    settingPut,
    settingGet,
    studentTeamGet,
    studentTeamPost,
    teacherTeamsGet,
    teacherTeamsPost,
    teacherMemberPost,
    studentContributionGet,
    teacherContributionGet,
  ] as const;
  return contracts.map((contract) => ({
    contract,
    async handle(request, response, params) {
      const token = liveSessionTokenFromCookie(request.headers.cookie);
      if (token === undefined) return refuse(response, 401, "unauthorized");

      // A path id that is not a UUID is the same 404 as another's assignment or team.
      const input = { assignmentId: params?.assignmentId ?? "", teamId: params?.teamId ?? "" };
      if (contract.request.params !== undefined) {
        const shape =
          contract.request.params.properties.teamId === undefined
            ? { assignmentId: input.assignmentId }
            : input;
        if (!Value.Check(contract.request.params, shape)) return refuse(response, 404, "not_found");
      }
      const assignmentId = input.assignmentId.toLowerCase();
      const teamId = input.teamId.toLowerCase();

      let body: Json = {};
      if (contract.request.body !== undefined) {
        const types = request.headersDistinct["content-type"];
        if (types?.length !== 1 || !JSON_MEDIA_TYPE.test(types[0] ?? "")) {
          return refuse(response, 415, "unsupported_media_type");
        }
        const raw = await readBodyWithLimit(
          request,
          contract.request.maxBodyBytes!,
          BODY_TIMEOUT_MS,
        );
        if (!raw.ok) return refuse(response, raw.status, raw.reason);
        const json = parseJson(raw.bytes);
        if (!json.ok) return sendProblem(response, 400, "invalid_json");
        if (!Value.Check(contract.request.body, json.value)) {
          return sendProblem(response, 422, "invalid_input");
        }
        body = json.value as Json;
      }

      try {
        let result: unknown;
        if (contract === settingPut) {
          result = await store.setSetting(token, assignmentId, body as never);
        } else if (contract === settingGet) {
          result = await store.setting(token, assignmentId);
        } else if (contract === studentTeamGet) {
          result = await store.studentTeam(token, assignmentId);
        } else if (contract === studentTeamPost) {
          const action = body as { action: "create" | "join" | "leave"; teamId?: string };
          result = await store.studentAction(token, assignmentId, {
            action: action.action,
            ...(action.teamId === undefined ? {} : { teamId: action.teamId.toLowerCase() }),
          });
        } else if (contract === teacherTeamsGet) {
          result = await store.teacherTeams(token, assignmentId);
        } else if (contract === teacherTeamsPost) {
          result = await store.createTeam(token, assignmentId);
        } else if (contract === teacherMemberPost) {
          const member = body as { studentId: string; action: "add" | "remove" };
          result = await store.teamMember(token, assignmentId, teamId, {
            studentId: member.studentId.toLowerCase(),
            action: member.action,
          });
        } else if (contract === studentContributionGet) {
          result = await store.studentContribution(token, assignmentId);
        } else {
          result = await store.teacherContribution(token, assignmentId, teamId);
        }
        const success = contract.responses[0]!;
        if (!Value.Check(success.body!, result)) throw new Error("invalid work team result");
        sendJson(response, success.status, result);
      } catch (error) {
        const refusal = refusalOf(error);
        if (refusal !== undefined) return sendProblem(response, ...refusal);
        reportServerError("route", error, requestIdOf(response), contract.id);
        return sendProblem(response, 503, "unavailable");
      }
      if (contract.method !== "GET") void recordActivity(token, withActor).catch(() => undefined);
    },
  }));
}

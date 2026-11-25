// SRV-V19-GRUPA-UGOVOR (Ductus#2055; val 19, docs/nalazi/val19-razlika.md §5
// task 6): the contract of work teams on an assignment. The teacher turns teams
// on per assignment (size 2 to 6, formed by the students or by the teacher);
// every member does their own part of the work. The contribution is one record
// for the student and the teacher alike, in the order of the members' family and
// given names, with the count of code points per kind of origin of each member
// and the permanent notice that it is not evidence of authorship (C-6 (a), P-B).
// It has no share, rank, comparison, average, threshold or colour, and no route
// besides the two contribution routes carries it (OP-V19-2: no percent per
// member until the owner decides). Another's, an unknown and a malformed
// assignment or team all read the same 404 (C-23). The database (a later task)
// decides access; the contract only declares it. The text is in
// docs/contracts/work-team-v1.md.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const Uuid = `[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}`;
const Id = Type.String({ pattern: `^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}${END}` });
/** A path or body id: the same shape, either case; a malformed one is the same 404. */
const IdParam = Type.String({ pattern: `^${Uuid}${END}` });
/** A name of a person, one line. */
const PersonName = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,100}(?<!\\s)${END}`,
});

/** The fewest and the most members a team may be set to. */
export const WORK_TEAM_SIZE_MIN = 2;
export const WORK_TEAM_SIZE_MAX = 6;
/** The most teams of one assignment one answer lists. */
export const WORK_TEAMS_MAX = 500;
/** The most students without a team one answer lists. */
export const WORK_TEAM_UNASSIGNED_MAX = 5000;
/** How a team is formed (the teacher chooses per assignment). */
export const WORK_TEAM_FORMATIONS = ["student_choice", "teacher_assigned"] as const;
/** The state of one member's own part, a closed list of facts and no grade. */
export const WORK_TEAM_WORK_STATES = ["not_started", "in_progress", "submitted"] as const;
/**
 * The kinds of origin a contribution counts, in the fixed order of
 * `categories` (the same list as the share of provenance-share-v1 §1.2).
 */
export const WORK_TEAM_CATEGORIES = [
  "written",
  "ai_transferred",
  "pasted",
  "imported",
  "unattributed",
] as const;
/** The only notice a contribution carries; it is never absent (P-B). */
export const WORK_TEAM_NOTICE = "not_authorship_evidence";

const Size = Type.Integer({ minimum: WORK_TEAM_SIZE_MIN, maximum: WORK_TEAM_SIZE_MAX });
const Formation = Type.Union(WORK_TEAM_FORMATIONS.map((value) => Type.Literal(value)));
const WorkState = Type.Union(WORK_TEAM_WORK_STATES.map((value) => Type.Literal(value)));
const Category = Type.Union(WORK_TEAM_CATEGORIES.map((value) => Type.Literal(value)));
const Count = Type.Integer({ minimum: 0, maximum: 9_007_199_254_740_991 });

const AssignmentParams = closed({ assignmentId: IdParam });
const TeamParams = closed({ assignmentId: IdParam, teamId: IdParam });

const Setting = closed({
  enabled: Type.Boolean(),
  minSize: Size,
  maxSize: Size,
  formation: Formation,
});
const Member = closed({ givenName: PersonName, familyName: PersonName });

/** What a student sees of their own team: the names of its members and nothing else. */
const OwnTeam = closed({
  teamId: Id,
  members: Type.Array(Member, { minItems: 1, maxItems: WORK_TEAM_SIZE_MAX }),
});
const StudentTeamState = Type.Union([
  closed({ state: Type.Literal("disabled") }),
  closed({
    state: Type.Literal("none"),
    formation: Formation,
    /** Teams with a free place the student may join; a team without names of members. Empty when the teacher forms the teams. */
    openTeams: Type.Array(
      closed({
        teamId: Id,
        memberCount: Type.Integer({ minimum: 1, maximum: WORK_TEAM_SIZE_MAX }),
      }),
      {
        maxItems: WORK_TEAMS_MAX,
      },
    ),
  }),
  closed({ state: Type.Literal("member"), team: OwnTeam }),
]);

const ContributionMember = closed({
  givenName: PersonName,
  familyName: PersonName,
  /** One entry per category, in the fixed order of WORK_TEAM_CATEGORIES. */
  categories: Type.Array(closed({ category: Category, codePoints: Count }), {
    minItems: WORK_TEAM_CATEGORIES.length,
    maxItems: WORK_TEAM_CATEGORIES.length,
  }),
  totalCodePoints: Count,
});
/** The one body of both contribution routes: the student's and the teacher's are the same bytes. */
const Contribution = Type.Union([
  closed({ state: Type.Literal("disabled") }),
  closed({ state: Type.Literal("none") }),
  closed({ state: Type.Literal("pending") }),
  closed({ state: Type.Literal("failed") }),
  closed({
    state: Type.Literal("ready"),
    members: Type.Array(ContributionMember, { minItems: 1, maxItems: WORK_TEAM_SIZE_MAX }),
    notice: Type.Literal(WORK_TEAM_NOTICE),
  }),
]);

const noStore = ["cache-control"];
const refusals = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  ...refusals,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
];
const ASSIGNMENT = "/{assignmentId}";

export const institutionAssignmentTeamSettingPut = defineRoute({
  id: "institution.assignment-team-setting.put",
  method: "PUT",
  path: `/api/v1/institution/assignments${ASSIGNMENT}/team-setting`,
  inventory: "app/api/institution/assignments/[assignmentId]/team-setting/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the course sets whether the assignment is done in teams, the fewest and the most members (2 to 6, minSize not above maxSize) and who forms the teams: the students or the teacher. Each call adds a version; the last one counts. With teams on, every member does their own part. A setting that would leave an existing team above maxSize is 409 conflict. An assignment that is another's, unknown or malformed reads 404.",
  request: {
    params: AssignmentParams,
    body: Setting,
    contentType: "application/json",
    maxBodyBytes: 1024,
  },
  responses: [
    {
      status: 200,
      description: "the setting now in force",
      body: Setting,
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "conflict")],
});

export const institutionAssignmentTeamSettingGet = defineRoute({
  id: "institution.assignment-team-setting.get",
  method: "GET",
  path: `/api/v1/institution/assignments${ASSIGNMENT}/team-setting`,
  inventory: "app/api/institution/assignments/[assignmentId]/team-setting/route.ts",
  access: "course_teacher",
  summary:
    "The setting in force for the assignment. An assignment that never had one reads as teams off (enabled false, minSize 2, maxSize 6, student_choice). Read by the teachers of the course; another's, an unknown or a malformed assignment reads 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the setting in force",
      body: Setting,
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const studentWorkTeamGet = defineRoute({
  id: "student.work-team.get",
  method: "GET",
  path: `/api/v1/student/assignments${ASSIGNMENT}/team`,
  inventory: "app/api/student/assignments/[assignmentId]/team/route.ts",
  access: "student_enrolled",
  summary:
    "The student's own team on the assignment, by state: disabled (the assignment has no teams), none (not in a team yet; with how the teams are formed and, when the students choose, the open teams as an id and a count of members, never names) or member (the team id and the given and family names of its members in alphabetical order). A student sees only their own team and never another one; an assignment the student is not enrolled in, unknown or malformed reads 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the student's team state",
      body: StudentTeamState,
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const studentWorkTeamPost = defineRoute({
  id: "student.work-team.post",
  method: "POST",
  path: `/api/v1/student/assignments${ASSIGNMENT}/team`,
  inventory: "app/api/student/assignments/[assignmentId]/team/route.ts",
  access: "student_enrolled",
  summary:
    "The student creates a team and becomes its first member (create), joins an open team by teamId (join) or leaves their team (leave); the answer is the state afterwards, as student.work-team.get gives it. create and join are allowed only when the students form the teams. teamId is required for join and refused for create and leave. A team above maxSize, a second team on the same assignment, a call while the teacher forms the teams and leaving after the student's own part was submitted are 409 conflict. A team that is another's or unknown reads 404. Teams are never deleted.",
  request: {
    params: AssignmentParams,
    body: Type.Union([
      closed({ action: Type.Literal("create") }),
      closed({ action: Type.Literal("join"), teamId: IdParam }),
      closed({ action: Type.Literal("leave") }),
    ]),
    contentType: "application/json",
    maxBodyBytes: 1024,
  },
  responses: [
    {
      status: 200,
      description: "the student's team state after the action",
      body: StudentTeamState,
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "conflict")],
});

export const teacherWorkTeamsGet = defineRoute({
  id: "teacher.work-teams.get",
  method: "GET",
  path: `/api/v1/teacher/assignments${ASSIGNMENT}/teams`,
  inventory: "app/api/teacher/assignments/[assignmentId]/teams/route.ts",
  access: "course_teacher",
  summary:
    "The teams of the assignment and the enrolled students without a team. Members and unassigned students are in the order of family name, then given name, then studentId; teams by the first member in that order, then teamId. A member carries the state of their own part as a fact (not_started, in_progress, submitted). It is a list of facts: no count of points, no comparison, no state of good or bad. Read by the teachers of the course; another's, an unknown or a malformed assignment reads 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the teams and the students without a team",
      body: closed({
        teams: Type.Array(
          closed({
            teamId: Id,
            members: Type.Array(
              closed({
                studentId: Id,
                givenName: PersonName,
                familyName: PersonName,
                workState: WorkState,
              }),
              { maxItems: WORK_TEAM_SIZE_MAX },
            ),
          }),
          { maxItems: WORK_TEAMS_MAX },
        ),
        unassigned: Type.Array(
          closed({ studentId: Id, givenName: PersonName, familyName: PersonName }),
          { maxItems: WORK_TEAM_UNASSIGNED_MAX },
        ),
      }),
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const teacherWorkTeamsPost = defineRoute({
  id: "teacher.work-teams.post",
  method: "POST",
  path: `/api/v1/teacher/assignments${ASSIGNMENT}/teams`,
  inventory: "app/api/teacher/assignments/[assignmentId]/teams/route.ts",
  access: "course_teacher",
  summary:
    "The teacher creates an empty team on the assignment, to add students to it (teams formed by the teacher need it; the route is added to the task's list as the smallest contract that makes teacher_assigned usable). With teams off it is 409 conflict. Another's, an unknown or a malformed assignment reads 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 201,
      description: "the created team",
      body: closed({ teamId: Id }),
      headers: noStore,
    },
  ],
  errors: [...MUTATION_GUARD, ...refusals, error(409, "conflict")],
});

export const teacherWorkTeamMemberPost = defineRoute({
  id: "teacher.work-team-member.post",
  method: "POST",
  path: `/api/v1/teacher/assignments${ASSIGNMENT}/teams/{teamId}/members`,
  inventory: "app/api/teacher/assignments/[assignmentId]/teams/[teamId]/members/route.ts",
  access: "course_teacher",
  summary:
    "The teacher adds an enrolled student to the team or removes one from it. Each is added to the record of the team and nothing is deleted. A student already in a team, a team above maxSize, teams off and removing a student whose own part was submitted are 409 conflict. A student not enrolled, a team of another assignment, unknown or malformed ids read 404.",
  request: {
    params: TeamParams,
    body: closed({
      studentId: IdParam,
      action: Type.Union([Type.Literal("add"), Type.Literal("remove")]),
    }),
    contentType: "application/json",
    maxBodyBytes: 1024,
  },
  responses: [
    {
      status: 200,
      description: "the member list changed",
      body: closed({ updated: Type.Literal(true) }),
      headers: noStore,
    },
  ],
  errors: [...writeErrors, error(409, "conflict")],
});

export const studentWorkTeamContributionGet = defineRoute({
  id: "student.work-team-contribution.get",
  method: "GET",
  path: `/api/v1/student/assignments${ASSIGNMENT}/team/contribution`,
  inventory: "app/api/student/assignments/[assignmentId]/team/contribution/route.ts",
  access: "student_enrolled",
  summary:
    "The contribution of the student's own team, by state: disabled, none (no team), pending (a member's part is not yet computed), failed (a computation failed; never with a reason) or ready. ready lists every member in alphabetical order of family name, then given name, with the code points per kind of origin in the fixed order and their total, and the permanent notice not_authorship_evidence. There is no share, rank, comparison, average, threshold or colour. The same bytes as teacher.work-team-contribution.get for the same team. Another's, an unknown or a malformed assignment reads 404.",
  request: { params: AssignmentParams },
  responses: [
    {
      status: 200,
      description: "the contribution state of the student's team",
      body: Contribution,
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const teacherWorkTeamContributionGet = defineRoute({
  id: "teacher.work-team-contribution.get",
  method: "GET",
  path: `/api/v1/teacher/assignments${ASSIGNMENT}/teams/{teamId}/contribution`,
  inventory: "app/api/teacher/assignments/[assignmentId]/teams/[teamId]/contribution/route.ts",
  access: "course_teacher",
  summary:
    "The contribution of one team, the same answer and the same bytes as student.work-team-contribution.get for a member of that team (the student sees what the teacher sees). It never orders teams or members by an amount and names no person above another. Read by the teachers of the course; another's, an unknown or a malformed assignment or team reads 404.",
  request: { params: TeamParams },
  responses: [
    {
      status: 200,
      description: "the contribution state of the team",
      body: Contribution,
      headers: noStore,
    },
  ],
  errors: refusals,
});

export const workTeamRoutes = [
  institutionAssignmentTeamSettingPut,
  institutionAssignmentTeamSettingGet,
  studentWorkTeamGet,
  studentWorkTeamPost,
  teacherWorkTeamsGet,
  teacherWorkTeamsPost,
  teacherWorkTeamMemberPost,
  studentWorkTeamContributionGet,
  teacherWorkTeamContributionGet,
] as const;

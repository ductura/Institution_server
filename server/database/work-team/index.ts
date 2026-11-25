// SRV-V19-GRUPA-RUTE (Ductus#2055; val 19): the adapter of the work teams. Every
// call is one withActor transaction with app.* RPCs of migration 20261219310000
// (work_team): the client never writes a table. Who may do what is decided by the
// RPCs from the relation (student enrolled, teacher of the course), never from a
// role alone; another's, an unknown and a malformed assignment or team all come
// back as ZD404. The order of people is the domain's (family name, given name,
// id), applied here again so it never depends on the collation of the database.
import {
  assembleContribution,
  compareByName,
  isValidTeamSetting,
  orderByName,
  type Contribution,
  type TeamMemberPart,
} from "../../domain/index.ts";
import type { ActorTransaction, WithActor } from "../index.ts";

type StudentTeamRow = {
  rowKind: "disabled" | "none" | "open" | "member";
  formation: string;
  teamId: string | null;
  memberCount: number | null;
  givenName: string | null;
  familyName: string | null;
};
type TeacherTeamRow = {
  teamId: string | null;
  studentId: string | null;
  givenName: string | null;
  familyName: string | null;
  workState: string | null;
};
type SettingRow = { enabled: boolean; minSize: number; maxSize: number; formation: string };

const SET_SETTING = `SELECT enabled, min_size AS "minSize", max_size AS "maxSize", formation
  FROM app.set_assignment_team_setting($1::uuid, $2::boolean, $3::integer, $4::integer, $5::text)`;
const GET_SETTING = `SELECT enabled, min_size AS "minSize", max_size AS "maxSize", formation
  FROM app.assignment_team_setting($1::uuid)`;
const TEAM_ACTION = "SELECT app.team_action($1::uuid, $2::text, $3::uuid) AS id";
const STUDENT_TEAM = `SELECT row_kind AS "rowKind", formation, team_id AS "teamId",
    member_count AS "memberCount", given_name AS "givenName", family_name AS "familyName"
  FROM app.student_team($1::uuid)`;
const TEACHER_TEAMS = `SELECT team_id AS "teamId", student_id AS "studentId", given_name AS "givenName",
    family_name AS "familyName", work_state AS "workState"
  FROM app.teacher_teams($1::uuid)`;
const CREATE_TEAM = "SELECT app.teacher_create_team($1::uuid) AS id";
const TEAM_MEMBER = "SELECT app.teacher_team_member($1::uuid, $2::uuid, $3::uuid, $4::text)";

/** The refusal the RPCs give for an input they would not accept, so the route answers 422 before a round trip. */
function invalidInput(): never {
  throw Object.assign(new Error("invalid input"), { code: "ZD422" });
}
function notFound(): never {
  throw Object.assign(new Error("not found"), { code: "ZD404" });
}
/** A person without a name on record is not shown under an invented one: the answer then fails its own contract and reads as unavailable. */
function named(row: { givenName: string | null; familyName: string | null }) {
  if (row.givenName === null || row.familyName === null)
    throw new Error("team member without a name");
  return { givenName: row.givenName, familyName: row.familyName };
}

export type StudentTeamState =
  | { state: "disabled" }
  | {
      state: "none";
      formation: "student_choice" | "teacher_assigned";
      openTeams: { teamId: string; memberCount: number }[];
    }
  | {
      state: "member";
      team: { teamId: string; members: { givenName: string; familyName: string }[] };
    };

const formationOf = (value: string) => {
  if (value !== "student_choice" && value !== "teacher_assigned")
    throw new Error("unknown formation");
  return value;
};

async function studentState(tx: ActorTransaction, assignmentId: string): Promise<StudentTeamState> {
  const { rows } = await tx.query<StudentTeamRow>(STUDENT_TEAM, [assignmentId]);
  const first = rows[0];
  if (first === undefined) throw new Error("missing team state");
  if (first.rowKind === "disabled") return { state: "disabled" };
  if (first.rowKind === "none") {
    return {
      state: "none",
      formation: formationOf(first.formation),
      openTeams: rows
        .filter((row) => row.rowKind === "open" && row.teamId !== null && row.memberCount !== null)
        .map((row) => ({ teamId: row.teamId!, memberCount: row.memberCount! }))
        .sort((a, b) => a.teamId.localeCompare(b.teamId)),
    };
  }
  const members = rows.filter((row) => row.rowKind === "member");
  const teamId = members[0]?.teamId;
  if (teamId === null || teamId === undefined) throw new Error("team without id");
  return {
    state: "member",
    team: {
      teamId,
      members: orderByName(members.map((row) => ({ ...named(row), id: "" }))).map(
        ({ givenName, familyName }) => ({ givenName, familyName }),
      ),
    },
  };
}

/** The teams and the students without a team, in the one order of the domain: members by name, teams by their first member (empty last), then id. */
function teamsOf(rows: readonly TeacherTeamRow[]) {
  const teams = new Map<
    string,
    {
      teamId: string;
      members: { id: string; givenName: string; familyName: string; workState: string }[];
    }
  >();
  const unassigned: { id: string; givenName: string; familyName: string }[] = [];
  for (const row of rows) {
    if (row.teamId === null) {
      if (row.studentId === null) throw new Error("student row without id");
      unassigned.push({ id: row.studentId, ...named(row) });
      continue;
    }
    const team = teams.get(row.teamId) ?? { teamId: row.teamId, members: [] };
    teams.set(row.teamId, team);
    if (row.studentId === null) continue;
    if (row.workState === null) throw new Error("member without a state");
    team.members.push({ id: row.studentId, ...named(row), workState: row.workState });
  }
  const ordered = [...teams.values()].map((team) => ({
    ...team,
    members: orderByName(team.members),
  }));
  ordered.sort((a, b) => {
    const [x, y] = [a.members[0], b.members[0]];
    if (x === undefined || y === undefined) {
      return Number(x === undefined) - Number(y === undefined) || a.teamId.localeCompare(b.teamId);
    }
    return compareByName(x, y) || a.teamId.localeCompare(b.teamId);
  });
  return {
    teams: ordered.map((team) => ({
      teamId: team.teamId,
      members: team.members.map(({ id, givenName, familyName, workState }) => ({
        studentId: id,
        givenName,
        familyName,
        workState,
      })),
    })),
    unassigned: orderByName(unassigned).map(({ id, givenName, familyName }) => ({
      studentId: id,
      givenName,
      familyName,
    })),
  };
}

/**
 * Where the per-member records of the contribution come from. SRV-1222 (the
 * stored record per submission, provenance-share-v1 §7) is not on this base, so
 * the default source is off: contribution reads `disabled` ("rute vraćaju
 * `disabled`", provenance-share-v1 §8) and nothing is computed here. When
 * SRV-1222 lands, its reader is passed in as `readParts`: it gets a team the
 * caller was already shown to belong to and returns the part of every member;
 * the assembly and the order stay the domain's.
 */
export type ContributionSource = {
  readonly enabled: boolean;
  readParts?: (
    tx: ActorTransaction,
    assignmentId: string,
    teamId: string,
  ) => Promise<readonly TeamMemberPart[]>;
};
const SOURCE_OFF: ContributionSource = { enabled: false };

export function createWorkTeamStore(withActor: WithActor, source: ContributionSource = SOURCE_OFF) {
  const contribution = async (
    tx: ActorTransaction,
    assignmentId: string,
    teamId: string,
  ): Promise<Contribution> => {
    if (!source.enabled || source.readParts === undefined) {
      return assembleContribution({ enabled: false, members: null });
    }
    return assembleContribution({
      enabled: true,
      members: await source.readParts(tx, assignmentId, teamId),
    });
  };
  return {
    setSetting: (
      token: string,
      assignmentId: string,
      input: { enabled: boolean; minSize: number; maxSize: number; formation: string },
    ) =>
      withActor(token, async (tx) => {
        if (!isValidTeamSetting(input)) invalidInput();
        const { rows } = await tx.query<SettingRow>(SET_SETTING, [
          assignmentId,
          input.enabled,
          input.minSize,
          input.maxSize,
          input.formation,
        ]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing setting");
        return rows[0];
      }),
    setting: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<SettingRow>(GET_SETTING, [assignmentId]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing setting");
        return rows[0];
      }),
    studentTeam: (token: string, assignmentId: string) =>
      withActor(token, (tx) => studentState(tx, assignmentId)),
    /** create, join or leave, then the state afterwards in the same transaction. */
    studentAction: (
      token: string,
      assignmentId: string,
      input: { action: "create" | "join" | "leave"; teamId?: string },
    ) =>
      withActor(token, async (tx) => {
        if ((input.action === "join") !== (input.teamId !== undefined)) invalidInput();
        await tx.query(TEAM_ACTION, [assignmentId, input.action, input.teamId ?? null]);
        return studentState(tx, assignmentId);
      }),
    teacherTeams: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<TeacherTeamRow>(TEACHER_TEAMS, [assignmentId]);
        return teamsOf(rows);
      }),
    createTeam: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<{ id: string }>(CREATE_TEAM, [assignmentId]);
        if (rows.length !== 1 || !rows[0]) throw new Error("missing created team");
        return { teamId: rows[0].id };
      }),
    teamMember: (
      token: string,
      assignmentId: string,
      teamId: string,
      input: { studentId: string; action: "add" | "remove" },
    ) =>
      withActor(token, async (tx) => {
        await tx.query(TEAM_MEMBER, [assignmentId, teamId, input.studentId, input.action]);
        return { updated: true as const };
      }),
    /** The contribution of the student's own team: the same answer the teacher reads. */
    studentContribution: (token: string, assignmentId: string) =>
      withActor(token, async (tx) => {
        const own = await studentState(tx, assignmentId);
        if (own.state === "disabled")
          return assembleContribution({ enabled: false, members: null });
        if (own.state === "none") {
          return assembleContribution({ enabled: source.enabled, members: null });
        }
        return contribution(tx, assignmentId, own.team.teamId);
      }),
    /** The contribution of one team of the assignment, for the teachers of the course. */
    teacherContribution: (token: string, assignmentId: string, teamId: string) =>
      withActor(token, async (tx) => {
        const { rows } = await tx.query<TeacherTeamRow>(TEACHER_TEAMS, [assignmentId]);
        // Another's, an unknown and a malformed team all read the same 404.
        if (!rows.some((row) => row.teamId === teamId)) notFound();
        return contribution(tx, assignmentId, teamId);
      }),
  };
}

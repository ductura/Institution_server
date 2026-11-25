// Work teams on the dev fake server (SRV-V19-GRUPA-UGOVOR): the setting of an
// assignment, the teams, and the contribution, with invented data. The real
// rules are the database's (a later task); the fake keeps its records in a
// WeakMap by state, so it adds nothing to State. The contribution has invented
// counts: it only shows the shape (members in alphabetical order, a count per
// kind of origin, the notice), never a share or an order by an amount.
import type { Operations } from "../../contracts/index.ts";
import type { Handlers } from "./server.ts";
import { teachesCourse, type Account, type Course, type State } from "./state.ts";

type Setting = Operations["institution.assignment-team-setting.put"]["body"];
type Team = { teamId: string; assignmentId: string; memberIds: string[] };
type TeamRecords = { settings: Map<string, Setting>; teams: Team[] };

/** The id of the first team a fake state creates (ids are counted, so a test can name it). */
export const FAKE_TEAM_ID = "7f000000-0000-4000-8000-000000000001";
const teamIdAt = (count: number) => `7f000000-0000-4000-8000-${String(count).padStart(12, "0")}`;

const DEFAULT_SETTING: Setting = {
  enabled: false,
  minSize: 2,
  maxSize: 6,
  formation: "student_choice",
};
const RECORDS = new WeakMap<object, TeamRecords>();
const CATEGORIES = ["written", "ai_transferred", "pasted", "imported", "unattributed"] as const;

function recordsOf(state: State): TeamRecords {
  let records = RECORDS.get(state);
  if (records === undefined) {
    records = { settings: new Map(), teams: [] };
    RECORDS.set(state, records);
  }
  return records;
}

function courseOf(state: State, assignmentId: string): Course | undefined {
  const assignment = state.assignments.find((a) => a.id === assignmentId.toLowerCase());
  return assignment === undefined
    ? undefined
    : state.courses.find((course) => course.id === assignment.courseId);
}

const nameOf = (state: State, id: string) => {
  const account = state.accounts.find((a) => a.id === id);
  return {
    givenName: account?.givenName ?? "Student",
    familyName: account?.familyName ?? "Nepoznat",
  };
};
const byName = (state: State) => (a: string, b: string) => {
  const x = nameOf(state, a);
  const y = nameOf(state, b);
  return (
    x.familyName.localeCompare(y.familyName) ||
    x.givenName.localeCompare(y.givenName) ||
    a.localeCompare(b)
  );
};
const settingOf = (state: State, assignmentId: string): Setting =>
  recordsOf(state).settings.get(assignmentId) ?? DEFAULT_SETTING;
const workState = (
  state: State,
  assignmentId: string,
  studentId: string,
): "not_started" | "in_progress" | "submitted" => {
  const work = state.works.find(
    (w) => w.assignmentId === assignmentId && w.studentId === studentId,
  );
  return work === undefined ? "not_started" : work.state;
};

function studentState(state: State, assignmentId: string, studentId: string) {
  const setting = settingOf(state, assignmentId);
  if (!setting.enabled) return { state: "disabled" as const };
  const teams = recordsOf(state).teams.filter((t) => t.assignmentId === assignmentId);
  const own = teams.find((t) => t.memberIds.includes(studentId));
  if (own !== undefined) {
    return {
      state: "member" as const,
      team: {
        teamId: own.teamId,
        members: [...own.memberIds].sort(byName(state)).map((id) => nameOf(state, id)),
      },
    };
  }
  return {
    state: "none" as const,
    formation: setting.formation,
    openTeams:
      setting.formation === "student_choice"
        ? teams
            .filter((t) => t.memberIds.length > 0 && t.memberIds.length < setting.maxSize)
            .map((t) => ({ teamId: t.teamId, memberCount: t.memberIds.length }))
            .sort((a, b) => a.teamId.localeCompare(b.teamId))
        : [],
  };
}

function contribution(state: State, assignmentId: string, team: Team | undefined) {
  if (!settingOf(state, assignmentId).enabled) return { state: "disabled" as const };
  if (team === undefined || team.memberIds.length === 0) return { state: "none" as const };
  const ids = [...team.memberIds].sort(byName(state));
  if (ids.some((id) => workState(state, assignmentId, id) !== "submitted"))
    return { state: "pending" as const };
  return {
    state: "ready" as const,
    members: ids.map((id, index) => {
      const counts = CATEGORIES.map((category, at) => ({
        category,
        codePoints: at === 0 ? 100 * (index + 1) : 0,
      }));
      return { ...nameOf(state, id), categories: counts, totalCodePoints: 100 * (index + 1) };
    }),
    notice: "not_authorship_evidence" as const,
  };
}

const teacherTeam = (state: State, account: Account, assignmentId: string, teamId: string) => {
  const course = courseOf(state, assignmentId);
  if (course === undefined || !teachesCourse(course, account)) return undefined;
  return recordsOf(state).teams.find(
    (t) => t.teamId === teamId.toLowerCase() && t.assignmentId === assignmentId.toLowerCase(),
  );
};

export const WORK_TEAM_HANDLERS: Handlers = {
  "institution.assignment-team-setting.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseOf(state, params.assignmentId);
    if (course === undefined || !teachesCourse(course, account)) return { error: "not_found" };
    if (body.minSize > body.maxSize) return { error: "invalid_input" };
    const id = params.assignmentId.toLowerCase();
    const tooBig = recordsOf(state).teams.some(
      (t) => t.assignmentId === id && t.memberIds.length > body.maxSize,
    );
    if (tooBig) return { error: "conflict" };
    recordsOf(state).settings.set(id, { ...body });
    return { status: 200, body: { ...body } };
  },
  "institution.assignment-team-setting.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseOf(state, params.assignmentId);
    if (course === undefined || !teachesCourse(course, account)) return { error: "not_found" };
    return { status: 200, body: { ...settingOf(state, params.assignmentId.toLowerCase()) } };
  },
  "student.work-team.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseOf(state, params.assignmentId);
    if (course === undefined || !course.studentIds.includes(account.id))
      return { error: "not_found" };
    return {
      status: 200,
      body: studentState(state, params.assignmentId.toLowerCase(), account.id),
    };
  },
  "student.work-team.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseOf(state, params.assignmentId);
    if (course === undefined || !course.studentIds.includes(account.id))
      return { error: "not_found" };
    const id = params.assignmentId.toLowerCase();
    const setting = settingOf(state, id);
    const records = recordsOf(state);
    const own = records.teams.find(
      (t) => t.assignmentId === id && t.memberIds.includes(account.id),
    );
    if (body.action === "leave") {
      if (own === undefined || workState(state, id, account.id) === "submitted")
        return { error: "conflict" };
      own.memberIds = own.memberIds.filter((m) => m !== account.id);
    } else {
      if (!setting.enabled || setting.formation !== "student_choice" || own !== undefined)
        return { error: "conflict" };
      if (body.action === "create") {
        records.teams.push({
          teamId: teamIdAt(records.teams.length + 1),
          assignmentId: id,
          memberIds: [account.id],
        });
      } else {
        const team = records.teams.find(
          (t) => t.teamId === body.teamId.toLowerCase() && t.assignmentId === id,
        );
        if (team === undefined) return { error: "not_found" };
        if (team.memberIds.length >= setting.maxSize) return { error: "conflict" };
        team.memberIds.push(account.id);
      }
    }
    return { status: 200, body: studentState(state, id, account.id) };
  },
  "teacher.work-teams.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseOf(state, params.assignmentId);
    if (course === undefined || !teachesCourse(course, account)) return { error: "not_found" };
    const id = params.assignmentId.toLowerCase();
    const teams = recordsOf(state).teams.filter((t) => t.assignmentId === id);
    const inTeam = new Set(teams.flatMap((t) => t.memberIds));
    const sorted = byName(state);
    return {
      status: 200,
      body: {
        teams: teams
          .map((t) => ({
            teamId: t.teamId,
            members: [...t.memberIds].sort(sorted).map((studentId) => ({
              studentId,
              ...nameOf(state, studentId),
              workState: workState(state, id, studentId),
            })),
          }))
          .sort(
            (a, b) =>
              sorted(a.members[0]?.studentId ?? "", b.members[0]?.studentId ?? "") ||
              a.teamId.localeCompare(b.teamId),
          ),
        unassigned: course.studentIds
          .filter((studentId) => !inTeam.has(studentId))
          .sort(sorted)
          .map((studentId) => ({ studentId, ...nameOf(state, studentId) })),
      },
    };
  },
  "teacher.work-teams.post": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseOf(state, params.assignmentId);
    if (course === undefined || !teachesCourse(course, account)) return { error: "not_found" };
    const id = params.assignmentId.toLowerCase();
    if (!settingOf(state, id).enabled) return { error: "conflict" };
    const teamId = teamIdAt(recordsOf(state).teams.length + 1);
    recordsOf(state).teams.push({ teamId, assignmentId: id, memberIds: [] });
    return { status: 201, body: { teamId } };
  },
  "teacher.work-team-member.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const team = teacherTeam(state, account, params.assignmentId, params.teamId);
    const course = courseOf(state, params.assignmentId);
    const studentId = body.studentId.toLowerCase();
    if (team === undefined || course === undefined || !course.studentIds.includes(studentId))
      return { error: "not_found" };
    const setting = settingOf(state, team.assignmentId);
    if (!setting.enabled) return { error: "conflict" };
    if (body.action === "add") {
      const taken = recordsOf(state).teams.some(
        (t) => t.assignmentId === team.assignmentId && t.memberIds.includes(studentId),
      );
      if (taken || team.memberIds.length >= setting.maxSize) return { error: "conflict" };
      team.memberIds.push(studentId);
    } else {
      if (!team.memberIds.includes(studentId)) return { error: "not_found" };
      if (workState(state, team.assignmentId, studentId) === "submitted")
        return { error: "conflict" };
      team.memberIds = team.memberIds.filter((m) => m !== studentId);
    }
    return { status: 200, body: { updated: true } };
  },
  "student.work-team-contribution.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseOf(state, params.assignmentId);
    if (course === undefined || !course.studentIds.includes(account.id))
      return { error: "not_found" };
    const id = params.assignmentId.toLowerCase();
    const team = recordsOf(state).teams.find(
      (t) => t.assignmentId === id && t.memberIds.includes(account.id),
    );
    return { status: 200, body: contribution(state, id, team) };
  },
  "teacher.work-team-contribution.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const team = teacherTeam(state, account, params.assignmentId, params.teamId);
    if (team === undefined) return { error: "not_found" };
    return { status: 200, body: contribution(state, team.assignmentId, team) };
  },
};

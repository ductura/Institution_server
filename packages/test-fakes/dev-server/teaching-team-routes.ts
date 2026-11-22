import type { Handlers } from "./server.ts";
import type { State } from "./state.ts";

function courseFor(state: State, courseId: string) {
  return state.courses.find((course) => course.id === courseId.toLowerCase());
}

function normalize(ids: string[]): string[] {
  return ids.map((id) => id.toLowerCase());
}

function nameOf(state: State, id: string): string {
  const account = state.accounts.find((a) => a.id === id);
  return account === undefined ? "" : `${account.givenName} ${account.familyName}`.trim();
}

export const TEACHING_TEAM_HANDLERS: Handlers = {
  "institution.teaching-team-view.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseFor(state, params.id);
    if (course === undefined || !account.roles.includes("teacher")) return { error: "forbidden" };
    const assistantIds = [...(course.teachingAssistants ?? [])]
      .filter(([id, active]) => active && id !== course.holderId)
      .map(([id]) => id)
      .sort();
    if (course.holderId === account.id) {
      return {
        status: 200,
        body: {
          role: "holder",
          holderId: course.holderId,
          assistants: assistantIds.map((id) => ({ id, name: nameOf(state, id) })),
          students: [...course.studentIds].sort().map((id) => ({
            id,
            name: nameOf(state, id),
            groupId: course.groups.find((g) => g.studentIds.includes(id))?.id ?? null,
          })),
          groups: course.groups.map((g) => ({
            id: g.id,
            name: g.name,
            assistantIds: g.teacherIds.filter((id) => assistantIds.includes(id)).sort(),
          })),
        },
      };
    }
    if (!assistantIds.includes(account.id)) return { error: "forbidden" };
    return {
      status: 200,
      body: {
        role: "assistant",
        groups: course.groups
          .filter((g) => g.teacherIds.includes(account.id))
          .map((g) => ({
            id: g.id,
            name: g.name,
            students: [...g.studentIds].sort().map((id) => ({ id, name: nameOf(state, id) })),
          })),
      },
    };
  },
  "institution.teaching-team.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseFor(state, params.id);
    if (
      course === undefined ||
      !account.roles.includes("teacher") ||
      (course.holderId !== account.id && course.teachingAssistants?.get(account.id) !== true)
    ) {
      return { error: "forbidden" };
    }
    const assistantIds = [...(course.teachingAssistants ?? [])]
      .filter(([id, active]) => active && id !== course.holderId)
      .map(([id]) => id)
      .sort();
    return { status: 200, body: { holderId: course.holderId, assistantIds } };
  },
  "institution.teaching-team.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseFor(state, params.id);
    if (course?.holderId !== account.id || !account.roles.includes("teacher")) {
      return { error: "forbidden" };
    }
    const ids = normalize(body.assistantIds);
    if (
      new Set(ids).size !== ids.length ||
      ids.some(
        (id) =>
          id === account.id ||
          !state.accounts.some((a) => a.id === id && a.roles.includes("teacher")),
      )
    ) {
      return { error: "invalid_input" };
    }
    const team = (course.teachingAssistants ??= new Map());
    for (const [id, active] of team) {
      if (active && ids.includes(id)) continue;
      team.set(id, false);
      for (const group of course.groups) {
        group.teacherIds = group.teacherIds.filter((teacherId) => teacherId !== id);
      }
    }
    for (const id of ids) team.set(id, true);
    return { status: 200, body: { updated: true } };
  },
  "institution.teaching-group-members.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const course = courseFor(state, params.id);
    if (course?.holderId !== account.id || !account.roles.includes("teacher")) {
      return { error: "forbidden" };
    }
    const group = course.groups.find((candidate) => candidate.id === params.groupId.toLowerCase());
    if (group === undefined) return { error: "forbidden" };
    const assistantIds = normalize(body.assistantIds);
    const studentIds = normalize(body.studentIds);
    if (
      new Set(assistantIds).size !== assistantIds.length ||
      new Set(studentIds).size !== studentIds.length ||
      assistantIds.some((id) => course.teachingAssistants?.get(id) !== true) ||
      studentIds.some((id) => !course.studentIds.includes(id))
    ) {
      return { error: "invalid_input" };
    }
    if (
      course.groups.some(
        (other) => other !== group && studentIds.some((id) => other.studentIds.includes(id)),
      )
    ) {
      return { error: "conflict" };
    }
    group.teacherIds = assistantIds;
    group.studentIds = studentIds;
    return { status: 200, body: { updated: true } };
  },
};

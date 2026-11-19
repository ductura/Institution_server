// Course setup routes of the dev fake server (SRV-03, Ductus#2028
// c.7008147932): the administrator's course with its holder and groups, the
// seminar groups of a course and their teachers, and a teacher's new
// assignment. Access comes from relations in the state (a teacher of the
// course team, the administrator of the one institution), never from a role
// alone where the real server asks for a relation (C-23).
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import {
  parseInstant,
  teachesCourse,
  type Account,
  type AssignmentContent,
  type Course,
  type State,
} from "./state.ts";

const isAdmin = (account: Account | null): boolean =>
  account?.roles.includes("institution_admin") ?? false;
const isTeacher = (state: State, id: string): boolean =>
  state.accounts.some((a) => a.id === id && a.roles.includes("teacher"));

/** The course for its team (C-7) or the administrator; null for anyone else. */
function managedCourse(state: State, account: Account | null, id: string): Course | null {
  const course = state.courses.find((c) => c.id === id);
  if (course === undefined || account === null) return null;
  return isAdmin(account) || teachesCourse(course, account) ? course : null;
}

const byName = new Intl.Collator("hr");
const AI_POLICIES = ["prohibited", "partially_allowed", "encouraged"] as const;

/** The retry key of each created assignment and the content it was created with. */
const requests = new WeakMap<State, Map<string, { id: string; content: string }>>();

export const COURSE_SETUP_HANDLERS: Handlers = {
  "institution.admin-courses.post": ({ state, account, body }) => {
    if (account === null || !isAdmin(account)) return { error: "forbidden" };
    if (!isTeacher(state, body.holderId.toLowerCase())) return { error: "invalid_input" };
    if (new Set(body.groups).size !== body.groups.length) return { error: "invalid_input" };
    const holderId = body.holderId.toLowerCase();
    const same = state.courses.find(
      (c) =>
        c.createdBy === account.id && c.name === body.name && c.academicYear === body.academicYear,
    );
    if (same !== undefined) {
      if (same.aiPolicy !== body.aiPolicy || same.holderId !== holderId)
        return { error: "conflict" };
      return {
        status: 200,
        body: { id: same.id, groups: same.groups.map((g) => ({ id: g.id, name: g.name })) },
      };
    }
    const groups = body.groups.map((name) => ({
      id: randomUUID(),
      name,
      teacherIds: [],
      studentIds: [],
    }));
    const id = randomUUID();
    state.courses.push({
      id,
      name: body.name,
      academicYear: body.academicYear,
      aiPolicy: body.aiPolicy,
      holderId,
      createdBy: account.id,
      studentIds: [],
      groups,
      codes: [],
      removed: [],
    });
    return { status: 200, body: { id, groups: groups.map((g) => ({ id: g.id, name: g.name })) } };
  },
  "institution.course-groups.get": ({ state, account, params }) => {
    const course = managedCourse(state, account, params.courseId);
    if (course === null) return { error: "forbidden" };
    const groups = [...course.groups]
      .sort((a, b) => byName.compare(a.name, b.name) || (a.id < b.id ? -1 : 1))
      .map((g) => ({
        id: g.id,
        name: g.name,
        teachers: g.teacherIds
          .map((id) => state.accounts.find((a) => a.id === id))
          .filter((a): a is Account => a !== undefined)
          .sort(
            (a, b) =>
              byName.compare(a.familyName, b.familyName) ||
              byName.compare(a.givenName, b.givenName) ||
              (a.id < b.id ? -1 : 1),
          )
          .map((a) => ({ id: a.id, givenName: a.givenName, familyName: a.familyName })),
        students: g.studentIds.length,
      }));
    return { status: 200, body: { groups } };
  },
  "institution.course-groups.post": ({ state, account, params, body }) => {
    const course = managedCourse(state, account, params.courseId);
    if (course === null) return { error: "forbidden" };
    const same = course.groups.find((g) => g.name === body.name);
    if (same !== undefined) return { status: 200, body: { id: same.id } };
    const id = randomUUID();
    course.groups.push({ id, name: body.name, teacherIds: [], studentIds: [] });
    return { status: 200, body: { id } };
  },
  "institution.course-group-teachers.post": ({ state, account, params, body }) => {
    const course = state.courses.find((c) => c.groups.some((g) => g.id === params.groupId));
    if (course === undefined || managedCourse(state, account, course.id) === null)
      return { error: "forbidden" };
    const teacherId = body.teacherId.toLowerCase();
    if (!isTeacher(state, teacherId)) return { error: "invalid_input" };
    const group = course.groups.find((g) => g.id === params.groupId)!;
    if (group.teacherIds.includes(teacherId)) return { status: 200, body: { assigned: false } };
    group.teacherIds.push(teacherId);
    return { status: 200, body: { assigned: true } };
  },
  "institution.course-assignments.post": ({ state, account, params, body }) => {
    const course = state.courses.find((c) => c.id === params.courseId);
    if (course === undefined || account === null || !teachesCourse(course, account))
      return { error: "forbidden" };
    const opensAt = parseInstant(body.opensAt);
    const dueAt = parseInstant(body.dueAt);
    if (opensAt === null || dueAt === null) return { error: "invalid_input" };
    const { requestKey, ...fields } = body;
    const content: AssignmentContent = { ...fields, opensAt, dueAt };
    if (
      (content.wordMin !== null && content.wordMax !== null && content.wordMin > content.wordMax) ||
      (content.aiPolicy === "prohibited" && content.aiPurposes.length > 0) ||
      // An assignment keeps or narrows its course's rule on AI help.
      AI_POLICIES.indexOf(content.aiPolicy) > AI_POLICIES.indexOf(course.aiPolicy)
    )
      return { error: "invalid_input" };
    const key = requestKey.toLowerCase();
    const seen = requests.get(state) ?? new Map<string, { id: string; content: string }>();
    requests.set(state, seen);
    const text = JSON.stringify(content);
    const earlier = seen.get(key);
    if (earlier !== undefined) {
      if (earlier.content !== text) return { error: "conflict" };
      return { status: 201, body: { id: earlier.id } };
    }
    const id = randomUUID();
    seen.set(key, { id, content: text });
    state.assignments.push({
      id,
      courseId: course.id,
      version: 1,
      content,
      language: "hr",
      acknowledged: new Map(),
      read: new Map(),
      studentLanguage: new Map(),
    });
    return { status: 201, body: { id } };
  },
};

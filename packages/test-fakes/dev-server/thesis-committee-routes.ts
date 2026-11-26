import type { Handlers } from "./server.ts";
import { readerOf, type Account, type State } from "./state.ts";

// SRV-V16-POVJERENSTVO-ZAPIS: the committee of a thesis as a list kept with the
// work, on invented data only. Like SRV-MENTOR-2 the dev server has no
// mentorship of a work, so every work is taken as a thesis and "the mentor" is
// the teacher reader of the work; the real server decides through the
// mentorship (C-23). The list gives no right to read the work. Every change is
// kept, only the newest holds.

type Role = "chair" | "member";
type Change = { members: { userId: string; role: Role }[]; changedAt: string };

const MAX_MEMBERS = 5;
const CHANGES = new WeakMap<State, Map<string, Change[]>>();
function changesOf(state: State, documentId: string): Change[] {
  let all = CHANGES.get(state);
  if (all === undefined) {
    all = new Map();
    CHANGES.set(state, all);
  }
  let changes = all.get(documentId);
  if (changes === undefined) {
    changes = [];
    all.set(documentId, changes);
  }
  return changes;
}

function partOf(state: State, account: Account, documentId: string) {
  const work = state.works.find((entry) => entry.documentId === documentId);
  if (work === undefined) return null;
  const reader = readerOf(state, work, account);
  if (reader === "owner") return "student" as const;
  if (reader === "teacher") return "mentor" as const;
  return account.roles.includes("institution_admin") ? ("faculty" as const) : null;
}

function view(state: State, changes: Change[]) {
  const current = changes.at(-1) ?? null;
  const members = (current?.members ?? [])
    .map((member) => {
      const person = state.accounts.find((entry) => entry.id === member.userId);
      return {
        userId: member.userId,
        name:
          person === undefined
            ? null
            : { givenName: person.givenName, familyName: person.familyName },
        role: member.role,
      };
    })
    .sort(
      (a, b) =>
        Number(b.role === "chair") - Number(a.role === "chair") || a.userId.localeCompare(b.userId),
    );
  return {
    members,
    changedAt: current === null ? null : current.changedAt,
    changedByPart: current === null ? null : ("faculty" as const),
  };
}

const key = (members: readonly { userId: string; role: Role }[]) =>
  members
    .map((member) => `${member.userId}:${member.role}`)
    .sort()
    .join(",");

export const THESIS_COMMITTEE_HANDLERS: Handlers = {
  "work.thesis-committee.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (partOf(state, account, params.documentId) === null) return { error: "not_found" };
    return { status: 200, body: view(state, changesOf(state, params.documentId)) };
  },
  "work.thesis-committee.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const part = partOf(state, account, params.documentId);
    if (part === null) return { error: "not_found" };
    if (part !== "faculty") return { error: "forbidden" };
    const work = state.works.find((entry) => entry.documentId === params.documentId);
    const ids = body.members.map((member) => member.userId);
    const valid =
      body.members.length <= MAX_MEMBERS &&
      body.members.filter((member) => member.role === "chair").length <= 1 &&
      new Set(ids).size === ids.length &&
      ids.every((id) =>
        state.accounts.some((entry) => entry.id === id && entry.roles.includes("teacher")),
      ) &&
      !ids.includes(work?.studentId ?? "");
    if (!valid) return { error: "invalid_input" };
    const changes = changesOf(state, params.documentId);
    if (key(changes.at(-1)?.members ?? []) !== key(body.members)) {
      changes.push({
        members: body.members.map((member) => ({ ...member })),
        changedAt: new Date().toISOString(),
      });
    }
    return { status: 200, body: view(state, changes) };
  },
};

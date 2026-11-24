// SRV-MENTOR-3 on the dev fake server: the note to self and the reading place
// (work.self-note.*, work.reading-place.*), the seen marks (work.seen.post,
// work.seen-by-student.get) and the mentor's overview
// (mentorship.overview.get). Invented data only. The real rules are the RPCs
// of 20261217100000: the note is the owner's alone (anyone else reads 404),
// the first instant of a mark stays, and the overview has no score or rank.
// SRV-NF6-SIFRA (20261217150000): the note is sealed (self-note-sealed-routes);
// these routes keep no text and answer note null, as the real server.
// The fake knows the author of a message only by its senderRole, so a
// teacher reads as "own" every mark the student made on a teacher's message
// and on every other kind of item.
import type { Handlers } from "./server.ts";
import { conversationOf } from "./messages-routes.ts";
import { readerOf, type State, type Work } from "./state.ts";

type Place = { nodeId: string; offset: number };
/** The sealed parts as the contract writes them; the fake reads them no more than the server. */
export type Sealed = { v: 1; keyId: string; iv: string; ct: string };
export type Kept = {
  note: { sealed: Sealed; updatedAt: string } | null;
  readingPlace: { place: Place; updatedAt: string } | null;
};
type Kind = "comment" | "revision_request" | "milestone_revision" | "message";
type Mark = { kind: Kind; id: string; firstSeenAt: string };

/** What each fake state keeps, by work, and the marks by work and reader. */
const NOTES = new WeakMap<State, Map<string, Kept>>();
const MARKS = new WeakMap<State, Map<string, Mark[]>>();

export function keptOf(state: State, documentId: string): Kept {
  let all = NOTES.get(state);
  if (all === undefined) NOTES.set(state, (all = new Map()));
  let one = all.get(documentId);
  if (one === undefined) all.set(documentId, (one = { note: null, readingPlace: null }));
  return one;
}

function marksOf(state: State, documentId: string, readerId: string): Mark[] {
  let all = MARKS.get(state);
  if (all === undefined) MARKS.set(state, (all = new Map()));
  const key = `${documentId}/${readerId}`;
  let one = all.get(key);
  if (one === undefined) all.set(key, (one = []));
  return one;
}

/** What the routes in the clear answer: never a note (SRV-NF6-SIFRA). */
const snapshot = (kept: Kept) => ({ note: null, readingPlace: kept.readingPlace });
const BAD_TEXT = /[‪-‮⁦-⁩]/u;

/** The owned work, or null for anyone but its student (the RPC's ZD403). */
export function owned(state: State, accountId: string, documentId: string): Work | null {
  const work = state.works.find((w) => w.documentId === documentId);
  return work !== undefined && work.studentId === accountId ? work : null;
}

export const MENTORSHIP_FOLLOW_HANDLERS: Handlers = {
  "work.self-note.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    return { status: 200, body: snapshot(keptOf(state, params.documentId)) };
  },
  // Keeps nothing: the text is dropped, as the real server (1.110.0).
  "work.self-note.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    if (body.text.trim() === "" || BAD_TEXT.test(body.text)) return { error: "invalid_input" };
    return { status: 200, body: snapshot(keptOf(state, params.documentId)) };
  },
  "work.self-note.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    const kept = keptOf(state, params.documentId);
    kept.note = null;
    return { status: 200, body: snapshot(kept) };
  },
  "work.reading-place.put": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    const kept = keptOf(state, params.documentId);
    kept.readingPlace = { place: body.place, updatedAt: now.toISOString() };
    return { status: 200, body: snapshot(kept) };
  },
  "work.reading-place.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (owned(state, account.id, params.documentId) === null) return { error: "not_found" };
    const kept = keptOf(state, params.documentId);
    kept.readingPlace = null;
    return { status: 200, body: snapshot(kept) };
  },
  "work.seen.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    const own = reader === "owner" ? "student" : "teacher";
    const messages = conversationOf(state, work.documentId);
    const marks = marksOf(state, work.documentId, account.id);
    const answer: Mark[] = [];
    for (const item of body.items) {
      if (item.kind === "message") {
        const message = messages.find((m) => m.id === item.id);
        if (message === undefined || message.senderRole === own) continue;
      }
      let mark = marks.find((m) => m.kind === item.kind && m.id === item.id);
      if (mark === undefined) {
        marks.push((mark = { kind: item.kind, id: item.id, firstSeenAt: now.toISOString() }));
      }
      if (!answer.includes(mark)) answer.push(mark);
    }
    return { status: 200, body: { items: answer } };
  },
  "work.seen-by-student.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    if (reader === "owner") return { status: 200, body: { items: [] } };
    const messages = conversationOf(state, work.documentId);
    const items = marksOf(state, work.documentId, work.studentId).filter(
      (m) =>
        m.kind !== "message" ||
        messages.some((message) => message.id === m.id && message.senderRole === "teacher"),
    );
    return { status: 200, body: { items } };
  },
  "mentorship.overview.get": ({ state, account, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("teacher")) return { status: 200, body: { students: [] } };
    const day = (at: Date) =>
      Date.parse(at.toLocaleDateString("sv-SE", { timeZone: "Europe/Zagreb" })) / 86_400_000;
    const students = state.mentorships
      .filter((m) => m.mentorId === account.id)
      .map((m) => {
        const student = state.accounts.find((a) => a.id === m.studentId);
        const documentId = m.documentId;
        const milestones = documentId === null ? [] : (state.milestones.get(documentId) ?? []);
        const open = milestones
          .map((ms, index) => {
            const progress = state.milestoneProgress.get(`${documentId}/${ms.id}`);
            const due =
              progress?.state === "revision_requested" && progress.revisionDueAt !== null
                ? progress.revisionDueAt
                : ms.dueAt;
            return { ms, position: index + 1, state: progress?.state ?? "not_submitted", due };
          })
          .filter((s) => s.state !== "approved");
        const current = open[0];
        const seen = marksOf(state, documentId ?? "", account.id);
        const unread =
          documentId === null
            ? 0
            : conversationOf(state, documentId).filter(
                (message) =>
                  message.senderRole === "student" &&
                  !seen.some((mark) => mark.kind === "message" && mark.id === message.id),
              ).length;
        const dues = open
          .map((s) => s.due)
          .filter((due): due is string => due !== null)
          .sort();
        const next = dues[0] ?? null;
        const stageState =
          current === undefined
            ? null
            : (current.state as "not_submitted" | "submitted" | "revision_requested");
        return {
          mentorshipId: m.id,
          assignmentId: m.assignmentId,
          documentId,
          givenName: student?.givenName ?? null,
          familyName: student?.familyName ?? null,
          workType: m.workType,
          title: m.title,
          stage:
            current === undefined || stageState === null
              ? null
              : {
                  milestoneId: current.ms.id,
                  title: current.ms.title,
                  position: current.position,
                  state: stageState,
                },
          stageCount: milestones.length,
          waitingOn:
            stageState === "submitted" || unread > 0
              ? ("mentor" as const)
              : documentId === null ||
                  stageState === "not_submitted" ||
                  stageState === "revision_requested"
                ? ("student" as const)
                : ("none" as const),
          nextDeadlineAt: next,
          daysToNextDeadline: next === null ? null : Math.round(day(new Date(next)) - day(now)),
          newMessages: unread,
        };
      });
    return { status: 200, body: { students } };
  },
};

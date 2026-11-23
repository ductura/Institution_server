// SRV-MENTOR-1 (NF-6: MK-7, MK-3, MK-10, MK-5) on the dev fake server, with
// invented data only. The real rules are the functions of migration
// 20261215110000 (app.open_mentorship, institution.close_consultation_slot,
// collaboration.add_consultation_task and their reads); the fake keeps their
// answers and refusals:
//
// - a confirmed teacher opens a mentorship for a student of the institution;
//   the student reads it and one notice of it;
// - a slot carries an optional topic and preparation; the student withdraws a
//   request, the teacher declines one, either side cancels an answered slot
//   that lies ahead;
// - only the teacher of the work adds and marks agreed tasks; the student reads.
import type { Operations } from "../../contracts/index.ts";
import { slotTime, workRole } from "./consultation-slots.ts";
import type { Handlers } from "./server.ts";
import { readerOf, type Account, type Mentorship, type State } from "./state.ts";

type SlotDetail =
  Operations["work.consultation-slot-details.get"]["success"]["body"]["slots"][number];
type Task = Operations["work.consultation-tasks.get"]["success"]["body"]["tasks"][number];
type Entry = State["consultationSlots"][number];

const TITLES = new Map<Mentorship["workType"], string>([
  ["bachelor_thesis", "Završni rad"],
  ["master_thesis", "Diplomski rad"],
  ["specialist_thesis", "Specijalistički rad"],
  ["doctoral_thesis", "Doktorski rad"],
]);
const MAX_OPEN_REQUESTS = 20;
const MAX_TASKS = 20;

const serial = (prefix: string, n: number) =>
  `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
const minuteOf = (date: Date): string =>
  new Date(date.getTime() - (date.getTime() % 60_000)).toISOString();
const isTeacher = (account: Account) => account.roles.includes("teacher");
const nameOf = (state: State, id: string) => {
  const person = state.accounts.find((a) => a.id === id);
  return person === undefined
    ? null
    : { givenName: person.givenName, familyName: person.familyName };
};

function detailOf({ slot, detail, closed }: Entry): SlotDetail {
  return {
    ...slot,
    state: closed?.state ?? slot.state,
    topic: detail?.topic ?? null,
    closing: closed === undefined ? null : { by: closed.by, reason: closed.reason, at: closed.at },
    preparation: detail?.preparation ?? null,
  };
}

function taskOf(task: State["consultationTasks"][number]): Task {
  const mark = task.marks.at(-1);
  return {
    id: task.id,
    recordId: task.recordId,
    position: task.position,
    text: task.text,
    done: mark?.done ?? false,
    markedAt: mark?.at ?? null,
    createdAt: task.createdAt,
  };
}

function teacherWork(state: State, documentId: string, account: Account | null) {
  const work = state.works.find((w) => w.documentId === documentId);
  if (account === null) return { error: "unauthorized" as const };
  const role = readerOf(state, work, account);
  return work === undefined || role === null ? { error: "not_found" as const } : { work, role };
}

export const MENTORSHIP_CONSULTATION_HANDLERS: Handlers = {
  "mentorship.open.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const studentId = body.studentId.toLowerCase();
    const student = state.accounts.find((a) => a.id === studentId);
    if (
      !isTeacher(account) ||
      student === undefined ||
      studentId === account.id ||
      isTeacher(student)
    )
      return { error: "not_found" };
    if (state.mentorships.some((m) => m.studentId === studentId && m.workType === body.workType))
      return { error: "conflict" };
    const n = state.mentorshipOpenings.length + 1;
    const opened = now.toISOString();
    const due = new Date(now);
    due.setUTCDate(due.getUTCDate() + 365);
    const mentorship: Mentorship = {
      id: serial("3e700000", n),
      mentorId: account.id,
      studentId,
      assignmentId: serial("a5700000", n),
      title: TITLES.get(body.workType)!,
      dueAt: due.toISOString(),
      workType: body.workType,
      documentId: null,
    };
    state.mentorships.push(mentorship);
    state.mentorshipOpenings.push({
      mentorshipId: mentorship.id,
      topic: body.topic ?? null,
      openedAt: opened,
      notificationId: serial("00a70000", n),
      readAt: null,
    });
    return { status: 201, body: { mentorshipId: mentorship.id } };
  },
  "mentorship.student-mentorships.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    if (isTeacher(account)) return { error: "forbidden" };
    const mentorships = state.mentorships
      .filter((m) => m.studentId === account.id)
      .map((m) => {
        const opening = state.mentorshipOpenings.find((o) => o.mentorshipId === m.id);
        return {
          mentorshipId: m.id,
          assignmentId: m.assignmentId,
          workType: m.workType,
          topic: opening?.topic ?? null,
          mentorId: m.mentorId,
          mentorName: nameOf(state, m.mentorId),
          // The seeded mentorship has no instant of its own; an invented one.
          startedAt: opening?.openedAt ?? "2026-10-01T08:00:00.000Z",
          openedBy: opening === undefined ? ("request" as const) : ("teacher" as const),
        };
      })
      .reverse();
    return { status: 200, body: { mentorships } };
  },
  "notifications.mentorship-opened.list.get": ({ state, account, query }) => {
    if (account === null) return { error: "unauthorized" };
    const own = state.mentorshipOpenings
      .map((opening) => ({
        opening,
        mentorship: state.mentorships.find((m) => m.id === opening.mentorshipId)!,
      }))
      .filter(({ mentorship }) => mentorship.studentId === account.id)
      .reverse();
    let start = 0;
    if (query.before !== undefined) {
      const at = own.findIndex(
        ({ opening }) => opening.notificationId === query.before!.toLowerCase(),
      );
      if (at < 0) return { error: "not_found" };
      start = at + 1;
    }
    const rows = own.slice(start, start + 51).map(({ opening, mentorship }) => ({
      id: opening.notificationId,
      targetId: mentorship.id,
      workType: mentorship.workType,
      topic: opening.topic,
      mentorName: nameOf(state, mentorship.mentorId),
      createdAt: opening.openedAt,
      readAt: opening.readAt,
    }));
    const notifications = rows.slice(0, 50);
    return {
      status: 200,
      body: {
        notifications,
        nextBefore: rows.length > notifications.length ? notifications.at(-1)!.id : null,
      },
    };
  },
  "work.consultation-slot-details.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (workRole(state, params.documentId, account) === null) return { error: "forbidden" };
    const slots = state.consultationSlots
      .filter(({ documentId }) => documentId === params.documentId)
      .map(detailOf)
      .sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    return { status: 200, body: { slots } };
  },
  "work.consultation-slot-requests.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (workRole(state, params.documentId, account) !== "owner") return { error: "forbidden" };
    const startsAt = slotTime(body.startsAt, now);
    const open = state.consultationSlots.filter(
      ({ documentId, slot, closed }) =>
        documentId === params.documentId && closed === undefined && slot.state !== "confirmed",
    ).length;
    if (startsAt === null || open >= MAX_OPEN_REQUESTS) return { error: "invalid_input" };
    const entry: Entry = {
      documentId: params.documentId,
      slot: {
        id: serial("c0200000", state.consultationSlots.length + 1),
        startsAt,
        proposedAt: now.toISOString(),
        state: "requested",
      },
      detail: { topic: body.topic ?? null, preparation: body.preparation ?? null },
    };
    state.consultationSlots.push(entry);
    return { status: 201, body: detailOf(entry) };
  },
  "work.consultation-slot-close.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const role = workRole(state, params.documentId, account);
    const entry = state.consultationSlots.find(
      ({ documentId, slot }) => documentId === params.documentId && slot.id === params.slotId,
    );
    if (
      role === null ||
      entry === undefined ||
      (body.action === "withdraw" && role !== "owner") ||
      (body.action === "decline" && role !== "teacher")
    )
      return { error: "forbidden" };
    const open = entry.closed === undefined;
    const allowed =
      body.action === "cancel"
        ? open &&
          entry.slot.state !== "requested" &&
          Date.parse(entry.slot.startsAt) > now.getTime()
        : open && entry.slot.state === "requested";
    if (!allowed) return { error: "conflict" };
    entry.closed = {
      state:
        body.action === "withdraw"
          ? "withdrawn"
          : body.action === "decline"
            ? "declined"
            : "cancelled",
      by: role === "owner" ? "student" : "teacher",
      reason: body.reason ?? null,
      at: now.toISOString(),
    };
    return { status: 200, body: detailOf(entry) };
  },
  "work.consultation-tasks.get": ({ state, account, params }) => {
    const found = teacherWork(state, params.documentId, account);
    if (found.role === undefined) return { error: found.error };
    const order = state.consultations
      .filter((r) => r.documentId === params.documentId)
      .sort((a, b) => a.heldOn.localeCompare(b.heldOn))
      .map((r) => r.id);
    const tasks = state.consultationTasks
      .filter((t) => t.documentId === params.documentId)
      .sort(
        (a, b) => order.indexOf(a.recordId) - order.indexOf(b.recordId) || a.position - b.position,
      )
      .map(taskOf);
    return { status: 200, body: { tasks } };
  },
  "work.consultation-tasks.post": ({ state, account, params, body, now }) => {
    const found = teacherWork(state, params.documentId, account);
    if (found.role === undefined) return { error: found.error };
    const record = state.consultations.find(
      (r) => r.id === params.recordId && r.documentId === params.documentId,
    );
    if (found.role !== "teacher" || record === undefined) return { error: "not_found" };
    const position = state.consultationTasks.filter((t) => t.recordId === record.id).length + 1;
    if (body.text.trim() === "" || position > MAX_TASKS) return { error: "invalid_input" };
    const task = {
      id: serial("000000c2", state.consultationTasks.length + 1),
      documentId: params.documentId,
      recordId: record.id,
      position,
      text: body.text,
      createdAt: minuteOf(now),
      marks: [],
    };
    state.consultationTasks.push(task);
    return { status: 201, body: taskOf(task) };
  },
  "work.consultation-task-mark.post": ({ state, account, params, body, now }) => {
    const found = teacherWork(state, params.documentId, account);
    if (found.role === undefined) return { error: found.error };
    const task = state.consultationTasks.find(
      (t) => t.id === params.taskId && t.documentId === params.documentId,
    );
    if (found.role !== "teacher" || task === undefined) return { error: "not_found" };
    if ((task.marks.at(-1)?.done ?? false) !== body.done) {
      task.marks.push({ done: body.done, at: minuteOf(now) });
    }
    return { status: 200, body: taskOf(task) };
  },
};

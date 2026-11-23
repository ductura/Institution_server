import { createHash } from "node:crypto";

import type { Operations } from "../../contracts/index.ts";
import type { Handlers } from "./server.ts";
import { successBody } from "./contract.ts";
import { parseInstant, readerOf, type Account, type State } from "./state.ts";

type Interview = Operations["work.interview.get"]["success"]["body"];
type Entry = State["workInterviews"] extends Map<string, infer E> ? E : never;

function role(state: State, documentId: string, account: Account | null) {
  return readerOf(
    state,
    state.works.find((work) => work.documentId === documentId),
    account,
  );
}

function entryOf(state: State, documentId: string): Entry {
  let entry = state.workInterviews.get(documentId);
  if (entry === undefined) {
    entry = {
      invitedAt: null,
      questions: [],
      explanations: [],
      notes: [],
      appointment: null,
      heldOn: null,
    };
    state.workInterviews.set(documentId, entry);
  }
  return entry;
}

/** The preparation as `account` may read it: a draft only by its author, nothing to the student before the invitation. */
function view(entry: Entry, account: Account): Interview {
  return {
    invitedAt: entry.invitedAt,
    questions: entry.questions
      .filter(({ authorId }) => entry.invitedAt !== null || authorId === account.id)
      .map(({ authorId, question }) => ({ ...question, mine: authorId === account.id })),
    explanations: entry.invitedAt === null ? [] : entry.explanations,
    appointment: entry.appointment,
    heldOn: entry.heldOn,
  };
}

export const WORK_INTERVIEW_HANDLERS: Handlers = {
  "work.interview.get": ({ state, account, params }) => {
    const who = role(state, params.documentId, account);
    if (who === null || account === null) return { error: "forbidden" };
    const entry = state.workInterviews.get(params.documentId);
    if (who === "owner" && entry?.invitedAt == null) return { error: "forbidden" };
    return { status: 200, body: view(entryOf(state, params.documentId), account) };
  },
  "work.interview-pdf.get": ({ state, account, params }) => {
    const who = role(state, params.documentId, account);
    if (who === null || account === null) return { error: "forbidden" };
    // Only what the student reads goes into the PDF: nothing before the invitation.
    if (state.workInterviews.get(params.documentId)?.invitedAt == null) {
      return { error: who === "owner" ? "forbidden" : "conflict" };
    }
    return {
      status: 200,
      body: successBody(
        "work.interview-pdf.get",
      ) as Operations["work.interview-pdf.get"]["success"]["body"],
    };
  },
  "work.interview-questions.post": ({ state, account, params, body, now }) => {
    if (role(state, params.documentId, account) !== "teacher" || account === null)
      return { error: "forbidden" };
    const entry = entryOf(state, params.documentId);
    if (entry.questions.length >= 50 || body.questionText.trim() === "")
      return { error: "invalid_input" };
    const sequence = String(entry.questions.length + 1).padStart(12, "0");
    const question = {
      id: `c0300000-0000-4000-8000-${sequence}`,
      paragraphRef: body.paragraphRef ?? null,
      questionText: body.questionText,
      createdAt: now.toISOString(),
      mine: true,
    };
    entry.questions.push({ authorId: account.id, question });
    return { status: 201, body: question };
  },
  "work.interview-questions.delete": ({ state, account, params }) => {
    const entry = state.workInterviews.get(params.documentId);
    const found = entry?.questions.findIndex(({ question }) => question.id === params.questionId);
    if (
      role(state, params.documentId, account) !== "teacher" ||
      account === null ||
      entry === undefined ||
      found === undefined ||
      found < 0 ||
      (entry.invitedAt === null && entry.questions[found]!.authorId !== account.id)
    ) {
      return { error: "forbidden" };
    }
    entry.questions.splice(found, 1);
    for (const explanation of entry.explanations) {
      if (explanation.questionId === params.questionId) explanation.questionId = null;
    }
    return { status: 204 };
  },
  "work.interview-invite.post": ({ state, account, params, now }) => {
    if (role(state, params.documentId, account) !== "teacher" || account === null)
      return { error: "forbidden" };
    const entry = state.workInterviews.get(params.documentId);
    if (entry === undefined) return { error: "forbidden" };
    if (
      entry.invitedAt !== null ||
      !entry.questions.some(({ authorId }) => authorId === account.id)
    ) {
      return { error: "conflict" };
    }
    entry.invitedAt = now.toISOString();
    return { status: 200, body: view(entry, account) };
  },
  "work.interview-appointment.put": ({ state, account, params, body, now }) => {
    const who = role(state, params.documentId, account);
    if (who === null || account === null) return { error: "forbidden" };
    const free = "place" in body;
    const at = free ? parseInstant(body.at) : null;
    if (free && (at === null || Date.parse(at) <= now.getTime())) return { error: "invalid_input" };
    const entry = state.workInterviews.get(params.documentId);
    if (who === "owner" && (free || entry?.invitedAt == null)) return { error: "forbidden" };
    const slot = free
      ? undefined
      : state.consultationSlots.find(
          ({ documentId, slot }) =>
            documentId === params.documentId && slot.id === body.consultationSlotId,
        );
    if (!free && slot === undefined) return { error: "forbidden" };
    const current = entryOf(state, params.documentId);
    if (current.heldOn !== null) return { error: "conflict" };
    current.appointment = free
      ? { place: body.place, at: at! }
      : { consultationSlotId: slot!.slot.id, startsAt: slot!.slot.startsAt };
    return { status: 200, body: view(current, account) };
  },
  "work.interview-held.post": ({ state, account, params, body, now }) => {
    if (role(state, params.documentId, account) !== "teacher" || account === null)
      return { error: "forbidden" };
    const entry = state.workInterviews.get(params.documentId);
    if (entry === undefined) return { error: "forbidden" };
    const today = now.toISOString().slice(0, 10);
    if (Number.isNaN(Date.parse(body.date)) || body.date > today) return { error: "invalid_input" };
    if (entry.invitedAt === null || entry.heldOn !== null) return { error: "conflict" };
    entry.heldOn = body.date;
    return { status: 200, body: view(entry, account) };
  },
  "work.interview-explanations.post": ({ state, account, params, body, now }) => {
    const entry = state.workInterviews.get(params.documentId);
    if (role(state, params.documentId, account) !== "owner" || entry?.invitedAt == null)
      return { error: "forbidden" };
    const questionId = body.questionId ?? null;
    if (questionId !== null && !entry.questions.some(({ question }) => question.id === questionId))
      return { error: "forbidden" };
    if (body.text.trim() === "" || entry.explanations.length >= 100)
      return { error: "invalid_input" };
    const sequence = String(entry.explanations.length + 1).padStart(12, "0");
    const explanation = {
      id: `c0310000-0000-4000-8000-${sequence}`,
      questionId,
      text: body.text,
      createdAt: now.toISOString(),
    };
    entry.explanations.push(explanation);
    return { status: 201, body: explanation };
  },
  // PIL-K-RAZGOVOR-SRV: as institution.add_work_interview_note; 1 MiB, 20 notes.
  "work.interview-notes.post": ({ state, account, params, body, now }) => {
    const entry = state.workInterviews.get(params.documentId);
    if (role(state, params.documentId, account) !== "owner" || entry?.invitedAt == null)
      return { error: "forbidden" };
    const bytes = Buffer.from(body.contentBase64, "base64");
    let valid = bytes.toString("base64") === body.contentBase64 && bytes.length <= 1_048_576;
    if (valid && body.mediaType === "application/pdf") {
      valid = bytes.subarray(0, 5).toString("latin1") === "%PDF-";
    } else if (valid) {
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        valid = !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text);
      } catch {
        valid = false;
      }
    }
    if (!valid) return { error: "invalid_input" };
    if (entry.heldOn !== null) return { error: "conflict" };
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const kept = entry.notes.find((note) => note.sha256 === sha256);
    if (kept !== undefined) return { status: 201, body: kept };
    if (entry.notes.length >= 20) return { error: "invalid_input" };
    const note = {
      id: `c0320000-0000-4000-8000-${String(entry.notes.length + 1).padStart(12, "0")}`,
      fileName: body.fileName,
      mediaType: body.mediaType,
      byteSize: bytes.length,
      sha256,
      createdAt: now.toISOString(),
    };
    entry.notes.push(note);
    return { status: 201, body: note };
  },
};

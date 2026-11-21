// The short messages next to a work on the dev fake server (work.messages.get
// and work.messages.post, SRV-1106): one conversation per work that its
// student and the teachers of its course read and write alike, oldest first
// in the order of writing (readerOf). The real conversation, its bound and
// its refusals are collaboration.create_work_message and list_work_messages.
import { randomUUID } from "node:crypto";

import type { Handlers } from "./server.ts";
import { readerOf, type State } from "./state.ts";

type Message = {
  readonly id: string;
  readonly senderRole: "student" | "teacher";
  readonly text: string;
  readonly createdAt: string;
};

/** The conversations of each fake state, by work. */
const CONVERSATIONS = new WeakMap<State, Map<string, Message[]>>();

function conversationOf(state: State, documentId: string): Message[] {
  let all = CONVERSATIONS.get(state);
  if (all === undefined) CONVERSATIONS.set(state, (all = new Map()));
  let one = all.get(documentId);
  if (one === undefined) all.set(documentId, (one = []));
  return one;
}

export const MESSAGES_HANDLERS: Handlers = {
  "work.messages.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null)
      return { error: "not_found" };
    return { status: 200, body: { messages: [...conversationOf(state, work.documentId)] } };
  },
  "work.messages.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    const reader = readerOf(state, work, account);
    if (work === undefined || reader === null) return { error: "not_found" };
    const conversation = conversationOf(state, work.documentId);
    if (body.text.trim() === "" || conversation.length >= 1000) return { error: "invalid_input" };
    const message: Message = {
      id: randomUUID(),
      senderRole: reader === "owner" ? "student" : "teacher",
      text: body.text,
      createdAt: now.toISOString(),
    };
    conversation.push(message);
    return { status: 201, body: message };
  },
};

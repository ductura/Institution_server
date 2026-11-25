import type { Handlers } from "./server.ts";
import { readerOf, type Account, type State } from "./state.ts";

// SRV-V16-TEMA-PRIJEDLOG: the topic of a thesis, proposed by the student and
// decided by the mentor, on invented data only. Like SRV-MENTOR-2 the dev
// server has no mentorship of a work, so every work is taken as a thesis and
// "the mentor" is the teacher reader of the work; the real server decides
// through the mentorship (C-23). Versions and decisions are only ever added.

type Version = { version: number; title: string; summary: string; proposedAt: string };
type Decision = {
  version: number;
  decision: "approved" | "returned";
  comment: string | null;
  decidedAt: string;
  decidedByPart: "mentor";
};
type Topic = { versions: Version[]; decisions: Decision[] };

const MAX_VERSIONS = 100;
const TOPICS = new WeakMap<State, Map<string, Topic>>();
function topicOf(state: State, documentId: string): Topic {
  let all = TOPICS.get(state);
  if (all === undefined) {
    all = new Map();
    TOPICS.set(state, all);
  }
  let topic = all.get(documentId);
  if (topic === undefined) {
    topic = { versions: [], decisions: [] };
    all.set(documentId, topic);
  }
  return topic;
}

function partOf(state: State, account: Account, documentId: string) {
  const work = state.works.find((entry) => entry.documentId === documentId);
  if (work === undefined) return null;
  const reader = readerOf(state, work, account);
  if (reader === "owner") return "student" as const;
  if (reader === "teacher") return "mentor" as const;
  return account.roles.includes("institution_admin") ? ("faculty" as const) : null;
}

function view(topic: Topic) {
  const current = topic.versions.at(-1) ?? null;
  const decision =
    current === null
      ? null
      : (topic.decisions.filter((d) => d.version === current.version).at(-1) ?? null);
  return {
    state: current === null ? ("none" as const) : (decision?.decision ?? ("proposed" as const)),
    current: current === null ? null : { ...current },
    decision: decision === null ? null : { ...decision },
    history: topic.versions.map((entry) => ({ ...entry })),
  };
}

export const THESIS_TOPIC_HANDLERS: Handlers = {
  "work.thesis-topic.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    if (partOf(state, account, params.documentId) === null) return { error: "not_found" };
    return { status: 200, body: view(topicOf(state, params.documentId)) };
  },
  "work.thesis-topic.put": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const part = partOf(state, account, params.documentId);
    if (part === null) return { error: "not_found" };
    if (part !== "student") return { error: "forbidden" };
    const summary = body.summary ?? "";
    if (body.title.trim() === "" || (summary !== "" && summary.trim() === "")) {
      return { error: "invalid_input" };
    }
    const topic = topicOf(state, params.documentId);
    const now = view(topic);
    if (now.state === "approved") return { error: "conflict" };
    if (now.current?.title !== body.title || now.current.summary !== summary) {
      if (topic.versions.length >= MAX_VERSIONS) return { error: "conflict" };
      topic.versions.push({
        version: topic.versions.length + 1,
        title: body.title,
        summary,
        proposedAt: new Date().toISOString(),
      });
    }
    return { status: 200, body: view(topic) };
  },
  "work.thesis-topic-decision.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const part = partOf(state, account, params.documentId);
    if (part === null) return { error: "not_found" };
    if (part !== "mentor") return { error: "forbidden" };
    const comment = body.comment ?? null;
    if (
      (comment !== null && comment.trim() === "") ||
      (body.decision === "returned" && comment === null)
    ) {
      return { error: "invalid_input" };
    }
    const topic = topicOf(state, params.documentId);
    const now = view(topic);
    if (
      now.current?.version !== body.version ||
      now.state === "returned" ||
      (now.state === "approved" && body.decision !== "returned")
    ) {
      return { error: "conflict" };
    }
    topic.decisions.push({
      version: body.version,
      decision: body.decision,
      comment,
      decidedAt: new Date().toISOString(),
      decidedByPart: "mentor",
    });
    return { status: 200, body: view(topic) };
  },
};

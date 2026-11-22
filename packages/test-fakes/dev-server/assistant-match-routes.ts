// The match of a segment with the answers of the assistant on the dev fake
// server (work.assistant-match.get and .post, SRV-1230): the student who owns
// the work sends a segment, the owner and the readers of the work (readerOf)
// read the same findings, anyone else reads 404. The fake knows one invented
// answer of the assistant and matches a segment that holds its first eight
// words in a row after folding case and punctuation; the real rule is
// server/domain/assistant-match and app.assistant_match_*. Findings live in
// memory beside the state, one per segment reference and answer.
import type { Handlers } from "./server.ts";
import { readerOf } from "./state.ts";

const CONVERSATION = "000000a1-0000-4000-8000-000000000001";
const MESSAGE = "000000a1-0000-4000-8000-000000000002";
const ANSWER_WORDS = "kišobrani na tramvajskoj stanici čuvaju putnike od kiše".split(" ");

type Finding = {
  segmentRef: string;
  conversationId: string;
  messageId: string;
  runWords: number;
  recordedAt: string;
  attachedAt: string;
  documentId: string;
};
const FINDINGS = new WeakMap<object, Finding[]>();

const words = (text: string): string[] =>
  text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)
    .filter((w) => w !== "");

function runOf(text: string): number {
  const a = words(text);
  for (let i = 0; i + ANSWER_WORDS.length <= a.length; i++) {
    if (ANSWER_WORDS.every((word, k) => a[i + k] === word)) {
      return ANSWER_WORDS.length;
    }
  }
  return 0;
}

export const ASSISTANT_MATCH_HANDLERS: Handlers = {
  "work.assistant-match.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) === null) {
      return { error: "not_found" };
    }
    const findings = (FINDINGS.get(state) ?? [])
      .filter((finding) => finding.documentId === work.documentId)
      .map(({ documentId: _work, ...finding }) => finding);
    return { status: 200, body: { findings } };
  },
  "work.assistant-match.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) !== "owner") {
      return { error: "not_found" };
    }
    const runWords = runOf(body.text);
    if (runWords < 8) return { status: 200, body: { matches: [] } };
    const list = FINDINGS.get(state) ?? [];
    FINDINGS.set(state, list);
    if (!list.some((f) => f.documentId === work.documentId && f.segmentRef === body.segmentRef)) {
      const at = now.toISOString();
      list.push({
        documentId: work.documentId,
        segmentRef: body.segmentRef,
        conversationId: CONVERSATION,
        messageId: MESSAGE,
        runWords,
        recordedAt: at,
        attachedAt: at,
      });
    }
    return {
      status: 200,
      body: { matches: [{ messageId: MESSAGE, conversationId: CONVERSATION, runWords }] },
    };
  },
};

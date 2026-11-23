// Delayed comments, the comment bank and the review mark on the dev fake
// server (SRV-1703, D-51, N-03, N-05): the drafts of a teacher on a work, the
// teacher's saved comments and the revision a teacher last reviewed. The real
// rules, the 500 and 200 bounds and the refusals are collaboration.*_draft,
// publish_comments, the comment templates and mark_work_reviewed in PostgreSQL.
// This fake keeps the same separation (a draft and a bank entry are their
// author's alone, a student has no route to either) but not the comparison:
// publishing only clears the drafts and the changes answer carries no blocks,
// because the fake holds no record to reconstruct two versions from.
import type { Handlers } from "./server.ts";
import { readerOf, type State } from "./state.ts";

type Draft = {
  readonly threadId: string;
  readonly commentId: string;
  readonly position: number;
  readonly text: string;
  readonly anchor: Record<string, unknown>;
  readonly state: "open";
  readonly createdWindow: string;
  readonly authorId: string;
  readonly documentId: string;
};
type BankEntry = {
  readonly id: string;
  readonly kind: "must" | "sugg" | "q" | "praise";
  readonly text: string;
  readonly createdAt: string;
};

const COUNTERS = new WeakMap<State, number>();
/**
 * The next id of a fake state: fixed and in order (`c1700000-0000-4000-8000-`
 * then 12 digits), so a scenario can address what an earlier step wrote.
 */
function nextId(state: State): string {
  const n = (COUNTERS.get(state) ?? 0) + 1;
  COUNTERS.set(state, n);
  return `c1700000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

const DRAFTS = new WeakMap<State, Draft[]>();
const BANKS = new WeakMap<State, Map<string, BankEntry[]>>();
const REVIEWS = new WeakMap<State, Map<string, number>>();

const draftsOf = (state: State) => {
  let all = DRAFTS.get(state);
  if (all === undefined) DRAFTS.set(state, (all = []));
  return all;
};
const bankOf = (state: State, accountId: string) => {
  let all = BANKS.get(state);
  if (all === undefined) BANKS.set(state, (all = new Map()));
  let one = all.get(accountId);
  if (one === undefined) all.set(accountId, (one = []));
  return one;
};
const reviewsOf = (state: State) => {
  let all = REVIEWS.get(state);
  if (all === undefined) REVIEWS.set(state, (all = new Map()));
  return all;
};

/** The five-minute window of an instant, as the access log and the comments give it. */
const windowOf = (now: Date) =>
  new Date(Math.floor(now.getTime() / 300_000) * 300_000).toISOString();

export const COMMENTS_HANDLERS: Handlers = {
  "work.comment-drafts.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (readerOf(state, work, account) !== "teacher") return { error: "not_found" };
    const own = draftsOf(state).filter(
      (d) => d.authorId === account.id && d.documentId === params.documentId,
    );
    return {
      status: 200,
      body: { drafts: own.map(({ authorId: _author, documentId: _document, ...draft }) => draft) },
    };
  },
  "work.comment-drafts.post": ({ state, account, params, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (readerOf(state, work, account) !== "teacher") return { error: "not_found" };
    if (body.text.trim() === "") return { error: "invalid_input" };
    const drafts = draftsOf(state);
    if ("anchor" in body) {
      const threadId = nextId(state);
      drafts.push({
        threadId,
        commentId: nextId(state),
        position: 1,
        text: body.text,
        anchor: { ...body.anchor },
        state: "open",
        createdWindow: windowOf(now),
        authorId: account.id,
        documentId: work!.documentId,
      });
      return { status: 201, body: { threadId } };
    }
    const first = drafts.find(
      (d) =>
        d.threadId === body.threadId &&
        d.authorId === account.id &&
        d.documentId === params.documentId,
    );
    if (first === undefined) return { error: "not_found" };
    const commentId = nextId(state);
    drafts.push({
      ...first,
      commentId,
      position: drafts.filter((d) => d.threadId === first.threadId).length + 1,
      text: body.text,
      createdWindow: windowOf(now),
    });
    return { status: 201, body: { commentId } };
  },
  "work.comment-draft.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const drafts = draftsOf(state);
    const at = drafts.findIndex(
      (d) => d.commentId === params.commentId && d.authorId === account.id,
    );
    if (at === -1) return { error: "not_found" };
    const [gone] = drafts.splice(at, 1);
    if (gone!.position === 1) {
      for (let i = drafts.length - 1; i >= 0; i -= 1) {
        if (drafts[i]!.threadId === gone!.threadId) drafts.splice(i, 1);
      }
    }
    return { status: 204 };
  },
  "work.comments.publish.post": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (readerOf(state, work, account) !== "teacher") return { error: "not_found" };
    const drafts = draftsOf(state);
    const mine = (d: Draft) => d.authorId === account.id && d.documentId === params.documentId;
    const own = drafts.filter(mine);
    if (own.length === 0) return { error: "conflict" };
    DRAFTS.set(
      state,
      drafts.filter((d) => !mine(d)),
    );
    return { status: 200, body: { published: own.length } };
  },
  "work.comments.publish-selected.post": ({ state, account, params, body }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (readerOf(state, work, account) !== "teacher") return { error: "not_found" };
    const drafts = draftsOf(state);
    const mine = (d: Draft) => d.authorId === account.id && d.documentId === params.documentId;
    const own = new Set(drafts.filter(mine).map((d) => d.commentId.toLowerCase()));
    const seen = new Set((body as { draftIds: string[] }).draftIds.map((id) => id.toLowerCase()));
    if (own.size === 0 || own.size !== seen.size || [...own].some((id) => !seen.has(id))) {
      return { error: "conflict" };
    }
    DRAFTS.set(
      state,
      drafts.filter((d) => !mine(d)),
    );
    return { status: 200, body: { published: own.size } };
  },
  "teacher.comment-bank.get": ({ state, account }) => {
    if (account === null) return { error: "unauthorized" };
    return { status: 200, body: { entries: [...bankOf(state, account.id)] } };
  },
  "teacher.comment-bank.post": ({ state, account, body, now }) => {
    if (account === null) return { error: "unauthorized" };
    if (!account.roles.includes("teacher")) return { error: "not_found" };
    const bank = bankOf(state, account.id);
    if (body.text.trim() === "" || bank.length >= 200) return { error: "invalid_input" };
    const entry: BankEntry = {
      id: nextId(state),
      kind: body.kind,
      text: body.text,
      createdAt: now.toISOString(),
    };
    bank.push(entry);
    return { status: 201, body: { id: entry.id, createdAt: entry.createdAt } };
  },
  "teacher.comment-bank.delete": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const bank = bankOf(state, account.id);
    const at = bank.findIndex((e) => e.id === params.entryId);
    if (at === -1) return { error: "not_found" };
    bank.splice(at, 1);
    return { status: 204 };
  },
  "work.review.post": ({ state, account, params, now }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) !== "teacher") {
      return { error: "not_found" };
    }
    if (work.revision < 1) return { error: "conflict" };
    reviewsOf(state).set(`${account.id}:${work.documentId}`, work.revision);
    return {
      status: 200,
      body: { reviewedRevision: work.revision, reviewedAt: now.toISOString() },
    };
  },
  "work.changes-since-review.get": ({ state, account, params }) => {
    if (account === null) return { error: "unauthorized" };
    const work = state.works.find((w) => w.documentId === params.documentId);
    if (work === undefined || readerOf(state, work, account) !== "teacher") {
      return { error: "not_found" };
    }
    const reviewed = reviewsOf(state).get(`${account.id}:${work.documentId}`) ?? null;
    return {
      status: 200,
      body: {
        reviewedRevision: reviewed,
        currentRevision: work.revision,
        changed: reviewed !== null && work.revision > reviewed,
        blocks: [],
      },
    };
  },
};

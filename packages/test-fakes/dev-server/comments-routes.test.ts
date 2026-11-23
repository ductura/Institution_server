import { describe, expect, it } from "vitest";

import { refusesThreadRevision } from "./comments-routes.ts";
import { createState, IDS, type State } from "./index.ts";
import { send, signIn } from "./testing.ts";

// work.comments.publish-selected.post on the fake answers as the real route: the list must be
// exactly the teacher's drafts, each once. Invented texts only.
const ORIGIN = { origin: "http://127.0.0.1:4010", "sec-fetch-site": "same-origin" };

async function draft(state: State, headers: Record<string, string>): Promise<string> {
  const answer = await send(state, `/api/v1/works/${IDS.document}/comment-drafts`, {
    headers: { ...headers, ...ORIGIN },
    body: {
      text: "Izmišljena napomena o izvoru.",
      anchor: {
        nodeId: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c02",
        quote: "izmišljeni odlomak",
        prefix: "",
        suffix: "",
        startHint: 0,
        endHint: 18,
      },
    },
  });
  expect(answer.status).toBe(201);
  const { threadId } = answer.json as { threadId: string };
  // The client learns the comment id of a draft from the list it shows, as the teacher sees it.
  const listed = await send(state, `/api/v1/works/${IDS.document}/comment-drafts`, { headers });
  const drafts = (listed.json as { drafts: { threadId: string; commentId: string }[] }).drafts;
  return drafts.find((d) => d.threadId === threadId)!.commentId;
}

const publish = (state: State, headers: Record<string, string>, draftIds: string[]) =>
  send(state, `/api/v1/works/${IDS.document}/comments/publish-selected`, {
    headers: { ...headers, ...ORIGIN },
    body: { draftIds },
  });

describe("dev fake server: publishing the drafts the teacher saw", () => {
  it("refuses a repeated id even when it names the only draft, then publishes the exact list", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    const id = await draft(state, headers);
    const repeated = await publish(state, headers, [id, id]);
    expect(repeated.status).toBe(409);
    const exact = await publish(state, headers, [id]);
    expect([exact.status, exact.json]).toEqual([200, { published: 1 }]);
  });

  it("refuses a list that misses a draft written meanwhile", async () => {
    const state = createState();
    const headers = await signIn(state, "nastavnik");
    const seen = await draft(state, headers);
    await draft(state, headers);
    expect((await publish(state, headers, [seen])).status).toBe(409);
  });
});

// INT-15-SRV: collaboration.comments.post create carries the revision of its thread, as
// collaboration.check_thread_revision decides it; the list gives it on every row.
describe("dev fake server: the revision of a comment thread", () => {
  const ANCHOR = {
    nodeId: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c02",
    quote: "izmišljeni odlomak",
    prefix: "",
    suffix: "",
    startHint: 0,
    endHint: 18,
  };
  const comment = (
    state: State,
    headers: Record<string, string>,
    action: string,
    body: Record<string, unknown>,
  ) => send(state, `/api/v1/comments/${action}`, { headers: { ...headers, ...ORIGIN }, body });

  it("refuses a missing or wrong teacher revision and keeps a right one, also an older one", async () => {
    const state = createState();
    state.works.find((w) => w.documentId === IDS.document)!.revision = 3;
    const teacher = await signIn(state, "nastavnik");
    const base = { anchor: ANCHOR, body: "Izmišljeni komentar.", documentId: IDS.document };
    expect((await comment(state, teacher, "create", base)).status).toBe(422);
    expect((await comment(state, teacher, "create", { ...base, revision: 4 })).status).toBe(422);
    expect((await comment(state, teacher, "create", { ...base, revision: 0 })).status).toBe(422);
    const older = await comment(state, teacher, "create", { ...base, revision: 2 });
    expect(older.status).toBe(200);
    const general = { anchor: null, body: "Izmišljeni opći komentar.", documentId: IDS.document };
    expect((await comment(state, teacher, "create", general)).status).toBe(422);
    expect((await comment(state, teacher, "create", { ...general, revision: 3 })).status).toBe(200);

    const student = await signIn(state, "student");
    const own = await comment(state, student, "create", { ...base, body: "Izmišljeno pitanje." });
    expect(own.status).toBe(200);
    const threadId = (older.json as { id: string }).id;
    expect((await comment(state, student, "reply", { body: "Odgovor.", threadId })).status).toBe(
      200,
    );
    expect(
      (await comment(state, student, "reply", { body: "Odgovor.", threadId, revision: 2 })).status,
    ).toBe(422);

    const listed = await comment(state, student, "list", { documentId: IDS.document });
    const rows = (listed.json as { comments: { threadId: string; revision: number | null }[] })
      .comments;
    expect(rows.filter((r) => r.threadId === threadId).map((r) => r.revision)).toEqual([2, 2]);
    // The fake lists in the order written; the real list orders by thread.
    expect(rows.map((r) => r.revision)).toEqual([2, 3, null, 2]);
  });

  it("decides like the RPC", () => {
    expect(refusesThreadRevision({ revision: 2 }, "teacher", undefined)).toBe(true);
    expect(refusesThreadRevision({ revision: 2 }, "owner", undefined)).toBe(false);
    expect(refusesThreadRevision({ revision: 2 }, "owner", 3)).toBe(true);
    expect(refusesThreadRevision({ revision: 2 }, "teacher", 1)).toBe(false);
    expect(refusesThreadRevision({ revision: 2 }, "teacher", 1.5)).toBe(true);
    expect(refusesThreadRevision({ revision: 0 }, "teacher", 1)).toBe(true);
  });
});

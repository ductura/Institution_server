import { describe, expect, it } from "vitest";

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

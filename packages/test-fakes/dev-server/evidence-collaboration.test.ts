import { createPublicKey, verify } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  createState,
  EMPTY_DOCUMENT,
  FAKE_KEY_ID,
  FAKE_SIGNATURE,
  IDS,
  type State,
} from "./index.ts";
import { contractProblems, send, signIn } from "./testing.ts";

const EVIDENCE = { "ductus-protocol": "1" };
const SEGMENT = Buffer.from('{"izmisljeni":"odsjecak"}').toString("base64");

async function commit(
  state: State,
  headers: Record<string, string>,
  txid: string,
  baseRevision: number,
) {
  return send(state, "/api/v1/evidence/commit", {
    body: {
      documentId: IDS.document,
      clientTransactionId: txid,
      baseRevision,
      segments: [SEGMENT],
      document: EMPTY_DOCUMENT,
    },
    headers: { ...headers, ...EVIDENCE },
  });
}

type Signed = { payload: unknown; signature: { keyId: string; signatureBase64Url: string } };

describe("dev fake server: evidence is never signed", () => {
  it("marks every receipt with the fake key, and no receipt verifies under the key open lists", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    const opened = await send(state, "/api/v1/evidence/open", {
      body: { assignmentId: IDS.assignment },
      headers: { ...headers, ...EVIDENCE },
    });
    expect(contractProblems("evidence.open.post", opened)).toEqual([]);
    const key = (opened.json as { receiptKeys: { keyId: string; keyBase64Url: string }[] })
      .receiptKeys[0];
    expect(key?.keyId).toBe(FAKE_KEY_ID);
    const committed = await commit(state, headers, "izmisljena-1", 0);
    expect(contractProblems("evidence.commit.post", committed)).toEqual([]);
    const receipt = (committed.json as { receipt: { signedReceipt: Signed } }).receipt
      .signedReceipt;
    expect(receipt.signature).toMatchObject({
      keyId: FAKE_KEY_ID,
      signatureBase64Url: FAKE_SIGNATURE,
    });
    const publicKey = createPublicKey({
      key: Buffer.from(key?.keyBase64Url ?? "", "base64url"),
      format: "der",
      type: "spki",
    });
    const signature = Buffer.from(receipt.signature.signatureBase64Url, "base64url");
    expect(verify(null, Buffer.from(JSON.stringify(receipt.payload)), publicKey, signature)).toBe(
      false,
    );

    const submitted = await send(state, "/api/v1/submission", {
      body: { documentId: IDS.document, revision: 1 },
      headers: { ...headers, ...EVIDENCE },
    });
    expect(contractProblems("submission.submit.post", submitted)).toEqual([]);
    const submission = (submitted.json as { receipt: Signed }).receipt;
    expect(submission.signature).toMatchObject({
      keyId: FAKE_KEY_ID,
      signatureBase64Url: FAKE_SIGNATURE,
    });
  });

  it("answers a stale base with the work's state, a repeated transaction as duplicate, protocol 2 as pending", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    await commit(state, headers, "izmisljena-1", 0);
    const duplicate = await commit(state, headers, "izmisljena-1", 0);
    expect(duplicate.json).toMatchObject({ status: "duplicate", revision: 1 });
    const stale = await commit(state, headers, "izmisljena-2", 0);
    expect(contractProblems("evidence.commit.post", stale, "stale_base")).toEqual([]);
    expect(stale.json).toMatchObject({ status: "stale_base", currentRevision: 1 });
    const pending = await send(state, "/api/v1/evidence/commit", {
      body: {
        documentId: IDS.document,
        clientTransactionId: "izmisljena-3",
        baseRevision: 1,
        segments: [SEGMENT],
        document: EMPTY_DOCUMENT,
      },
      headers: { ...headers, "ductus-protocol": "2" },
    });
    expect(contractProblems("evidence.commit.post", pending)).toEqual([]);
    expect(pending.status).toBe(202);
  });

  it("refuses another student's work and a stale submission", async () => {
    const state = createState();
    const other = await commit(state, await signIn(state, "student-2"), "izmisljena-1", 0);
    expect(other.json).toMatchObject({ status: "not_found" });
    const headers = await signIn(state, "student");
    await commit(state, headers, "izmisljena-1", 0);
    const stale = await send(state, "/api/v1/submission", {
      body: { documentId: IDS.document, revision: 0 },
      headers,
    });
    expect(contractProblems("submission.submit.post", stale, "stale_revision")).toEqual([]);
    expect(stale.json).toMatchObject({ currentRevision: 1 });
  });
});

describe("dev fake server: live view and collaboration", () => {
  it("publishes the live state with a token, answers 304 to its ETag and logs a teacher's read", async () => {
    const state = createState();
    const url = `/api/v1/live/${IDS.document}`;
    const student = await signIn(state, "student");
    const body = { nodes: [], schemaVersion: 1 };
    const first = await send(state, url, {
      method: "PUT",
      body,
      headers: { ...student, "if-none-match": "*" },
    });
    const token = (first.json as { token: string }).token;
    const again = await send(state, url, {
      method: "PUT",
      body,
      headers: { ...student, "if-none-match": "*" },
    });
    expect(contractProblems("live.document.put", again)).toEqual([]);
    expect(again.json).toEqual({ outcome: "conflict", token });
    const none = await send(state, url, { method: "PUT", body, headers: student });
    expect(none.status).toBe(428);
    const teacher = await signIn(state, "nastavnik");
    const read = await send(state, url, { headers: teacher });
    const etag = String(read.headers.etag);
    const unchanged = await send(state, url, { headers: { ...teacher, "if-none-match": etag } });
    expect(unchanged.status).toBe(304);
    // Two reads in one five-minute window are one row of the access log.
    expect(state.accessLog.filter((e) => e.surface === "live_view")).toHaveLength(1);
  });

  it("keeps comment threads and hides a deleted comment's text", async () => {
    const state = createState();
    const teacher = await signIn(state, "nastavnik");
    const anchor = {
      nodeId: "0a000000-0000-4000-8000-000000000001",
      quote: "Izmišljeno",
      prefix: "",
      suffix: "",
      startHint: 0,
      endHint: 10,
    };
    const created = await send(state, "/api/v1/comments/create", {
      body: { anchor, body: "Izmišljeni komentar.", documentId: IDS.document },
      headers: teacher,
    });
    expect(created.status).toBe(200);
    const threadId = (created.json as { id: string }).id;
    const student = await signIn(state, "student");
    const reply = await send(state, "/api/v1/comments/reply", {
      body: { body: "Izmišljeni odgovor.", threadId },
      headers: student,
    });
    const replyId = (reply.json as { id: string }).id;
    await send(state, "/api/v1/comments/delete", {
      body: { commentId: replyId },
      headers: student,
    });
    const list = await send(state, "/api/v1/comments/list", {
      body: { documentId: IDS.document },
      headers: teacher,
    });
    expect(contractProblems("collaboration.comments.post", list)).toEqual([]);
    expect(list.json).toMatchObject({
      comments: [
        { authorRole: "teacher", isOwn: true, state: "answered" },
        { authorRole: "student", body: null, position: 1 },
      ],
    });
    const stranger = await send(state, "/api/v1/comments/list", {
      body: { documentId: IDS.document },
      headers: await signIn(state, "student-2"),
    });
    expect(stranger.status).toBe(403);
  });

  it("moves a revision request through its states and answers a stale sequence with 409 conflict", async () => {
    const state = createState();
    const teacher = await signIn(state, "nastavnik");
    const student = await signIn(state, "student");
    const anchor = {
      nodeId: "0a000000-0000-4000-8000-000000000001",
      quote: "Izmišljeno",
      prefix: "",
      suffix: "",
      startHint: 0,
      endHint: 10,
    };
    const created = await send(state, "/api/v1/revision-requests/create", {
      body: {
        anchor,
        documentId: IDS.document,
        instruction: "Izmišljena uputa.",
        requestedRevision: 0,
      },
      headers: teacher,
    });
    expect(created.status).toBe(200);
    const requestId = (created.json as { request_id: string }).request_id;
    const respond = {
      expectedSeq: 1,
      explanation: "Izmišljeno.",
      kind: "done",
      requestId,
      responseRevision: 0,
    };
    expect(
      (await send(state, "/api/v1/revision-requests/respond", { body: respond, headers: student }))
        .json,
    ).toMatchObject({
      outcome: "applied",
      state: "responded",
    });
    const stale = await send(state, "/api/v1/revision-requests/withdraw", {
      body: { expectedSeq: 1, requestId },
      headers: teacher,
    });
    expect(contractProblems("collaboration.revision-requests.post", stale)).toEqual([]);
    expect(stale.status).toBe(409);
    const notAllowed = await send(state, "/api/v1/revision-requests/respond", {
      body: { ...respond, expectedSeq: 2 },
      headers: student,
    });
    expect(notAllowed.json).toMatchObject({ error: "not_allowed" });
    const list = await send(state, "/api/v1/revision-requests/list", {
      body: { documentId: IDS.document },
      headers: student,
    });
    expect(contractProblems("collaboration.revision-requests.post", list)).toEqual([]);
  });
});

describe("dev fake server: review findings on #366", () => {
  it("pages the replay at 256 segments", async () => {
    const state = createState();
    const work = state.works[0];
    if (work === undefined) throw new Error("no work");
    work.segments = Array.from({ length: 300 }, (_, i) => `{"izmisljeni":${i}}`);
    const headers = { ...(await signIn(state, "student")), ...EVIDENCE };
    const first = await send(state, "/api/v1/evidence/replay", {
      body: { documentId: IDS.document, from: 0 },
      headers,
    });
    expect(contractProblems("evidence.replay.post", first)).toEqual([]);
    expect(first.json).toMatchObject({ next: 256, segmentCount: 300 });
    expect((first.json as { segments: unknown[] }).segments).toHaveLength(256);
  });

  it("serves the submitted revision in the live view, even without a live snapshot", async () => {
    const state = createState();
    const headers = await signIn(state, "student");
    await commit(state, headers, "izmisljena-1", 0);
    await send(state, "/api/v1/submission", {
      body: { documentId: IDS.document, revision: 1 },
      headers: { ...headers, ...EVIDENCE },
    });
    const live = await send(state, `/api/v1/live/${IDS.document}`, {
      headers: await signIn(state, "nastavnik"),
    });
    expect(live.status).toBe(200);
    expect(live.headers["ductus-live-state"]).toBe("submitted");
    expect(live.json).toEqual(JSON.parse(Buffer.from(EMPTY_DOCUMENT, "base64").toString("utf8")));
  });

  it("writes receipt instants with six fraction digits after a version with an offset", async () => {
    const state = createState();
    const assignment = state.assignments[0];
    if (assignment === undefined) throw new Error("no assignment");
    assignment.content.dueAt = "2027-01-31T23:59:00+01:00";
    const headers = await signIn(state, "student");
    await commit(state, headers, "izmisljena-1", 0);
    const submitted = await send(state, "/api/v1/submission", {
      body: { documentId: IDS.document, revision: 1 },
      headers: { ...headers, ...EVIDENCE },
    });
    expect(contractProblems("submission.submit.post", submitted)).toEqual([]);
    expect(submitted.json).toMatchObject({
      receipt: { payload: { dueAt: "2027-01-31T22:59:00.000000Z" } },
    });
  });

  it("refuses a body of another action with 422 and changes nothing", async () => {
    const state = createState();
    const teacher = await signIn(state, "nastavnik");
    const comment = await send(state, "/api/v1/comments/create", {
      body: { documentId: IDS.document },
      headers: teacher,
    });
    expect([comment.status, comment.json]).toMatchObject([422, { error: "invalid_input" }]);
    const request = await send(state, "/api/v1/revision-requests/create", {
      body: { documentId: IDS.document },
      headers: teacher,
    });
    expect(request.status).toBe(422);
    expect(state.comments).toHaveLength(0);
    expect(state.revisionRequests).toHaveLength(0);
  });
});

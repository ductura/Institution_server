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
    expect(state.accessLog.filter((e) => e.surface === "live_view")).toHaveLength(2);
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

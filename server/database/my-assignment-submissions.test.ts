// SRV-NF1-PREDANO (Ductus#2055 c.7145546227): the caller's own submission state
// for every assignment at once, from app.student_workspace() and
// app.my_submission_state(). Who asks comes only from the token inside
// withActor; one row the port cannot vouch for makes the whole answer
// ROW_MALFORMED. Negative cases first. Every token and id below is invented.
import { describe, expect, it } from "vitest";

import { createMyAssignmentSubmissionsReader } from "./my-assignment-submissions.ts";
import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_ROW_MALFORMED,
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
} from "./my-submission-state.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-popisa-predaja-00000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const C = "00000000-0000-4000-8000-0000000000c3";
const DIGEST = "a".repeat(64);
const AT = "2026-11-20T09:15:42.123456Z";

// The columns as the driver names them; built from entries, as they are no camelCase names.
const cols = (...entries: [string, unknown][]): Record<string, unknown> =>
  Object.fromEntries(entries);
const row = (id: unknown, over: Record<string, unknown> = {}): object => ({
  ...cols(
    ["assignment_id", id],
    ["state", "none"],
    ["revision", null],
    ["requested_at", null],
    ["receipt_payload", null],
    ["payload_digest_sha256", null],
    ["signature", null],
  ),
  ...over,
});
const ceka = cols(["state", "ceka"], ["revision", "3"], ["requested_at", AT]);
const potvrdeno = cols(
  ["state", "potvrdeno"],
  ["revision", "7"],
  ["requested_at", AT],
  ["receipt_payload", '{"izmisljeno":true}'],
  ["payload_digest_sha256", DIGEST],
  ["signature", { alg: "izmisljeno" }],
);
const at = (value: unknown) => cols(["requested_at", value]);
const digest = (value: unknown) => cols(["payload_digest_sha256", value]);

function reader(answer: unknown) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  let transactions = 0;
  const withActor = (async (token, fn) => {
    transactions += 1;
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return {
    port: createMyAssignmentSubmissionsReader(withActor),
    seen,
    transactions: () => transactions,
  };
}

const fail = (error: unknown) => ({ ok: false, error });
const UNAUTHENTICATED = fail(MY_SUBMISSION_STATE_UNAUTHENTICATED);
const MALFORMED = fail(MY_SUBMISSION_STATE_ROW_MALFORMED);
const DATABASE_ERROR = fail(MY_SUBMISSION_STATE_DATABASE_ERROR);
const sqlError = (code: unknown) => Object.assign(new Error("tekst greške baze"), { code });

describe("my assignment submissions: refusals", () => {
  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["short", "kratak"],
    ["with a forbidden character", `${TOKEN.slice(0, 42)}.`],
  ])("a %s token is unauthenticated without a transaction", async (_, token) => {
    const { port, transactions } = reader([]);
    expect(await port.read(token)).toEqual(UNAUTHENTICATED);
    expect(transactions()).toBe(0);
  });

  it("ZD401 is unauthenticated, any other failure a database error without its text", async () => {
    expect(await reader(sqlError("ZD401")).port.read(TOKEN)).toEqual(UNAUTHENTICATED);
    for (const code of ["ZD403", "57014", undefined, 401]) {
      const answer = await reader(sqlError(code)).port.read(TOKEN);
      expect(answer).toEqual(DATABASE_ERROR);
      expect(JSON.stringify(answer)).not.toContain("tekst greške baze");
    }
  });

  it.each<[string, unknown]>([
    ["not a list", { rows: [] }],
    ["a hole in the list", [row(A), , row(B)]],
    ["a row that is not an object", [row(A), "redak"]],
    ["no assignment id", [Object.fromEntries([["state", "none"]])]],
    ["an assignment id in capitals", [row(A.toUpperCase())]],
    ["a repeated assignment", [row(A), row(A, ceka)]],
    ["no state row for the assignment (LEFT JOIN)", [row(A, { state: null })]],
    ["not_found from the state function", [row(A, { state: "not_found" })]],
    ["an unknown state", [row(A, { state: "povuceno" })]],
    ["none with a revision", [row(A, { revision: "1" })]],
    ["ceka without a microsecond instant", [row(A, { ...ceka, ...at("2026-11-20") })]],
    ["ceka with a receipt", [row(A, { ...ceka, ...digest(DIGEST) })]],
    ["potvrdeno without a signature", [row(A, { ...potvrdeno, signature: null })]],
    ["potvrdeno with a short digest", [row(A, { ...potvrdeno, ...digest("ab") })]],
    ["one bad row among good ones", [row(A), row(B, potvrdeno), row(C, { revision: "x" })]],
  ])("%s makes the whole answer row_malformed", async (_, rows) => {
    expect(await reader(rows).port.read(TOKEN)).toEqual(MALFORMED);
  });
});

describe("my assignment submissions: the list", () => {
  it("is one statement in one transaction, with no parameter but the token", async () => {
    const { port, seen, transactions } = reader([]);
    expect(await port.read(TOKEN)).toEqual({ ok: true, value: [] });
    expect(transactions()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.token).toBe(TOKEN);
    expect(seen[0]?.values).toEqual([]);
    expect(seen[0]?.text).toContain("app.student_workspace()");
    expect(seen[0]?.text).toContain("app.my_submission_state(w.assignment_id)");
    expect(seen[0]?.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it("gives every state as the single read gives it, sorted by assignment", async () => {
    const { port } = reader([row(C, potvrdeno), row(A), row(B, ceka)]);
    expect(await port.read(TOKEN)).toEqual({
      ok: true,
      value: [
        { assignmentId: A, stored: { state: "none" } },
        { assignmentId: B, stored: { state: "ceka", revision: 3, requestedAt: AT } },
        {
          assignmentId: C,
          stored: {
            state: "potvrdeno",
            revision: 7,
            receiptPayload: '{"izmisljeno":true}',
            payloadDigestSha256: DIGEST,
            signature: { alg: "izmisljeno" },
          },
        },
      ],
    });
  });
});

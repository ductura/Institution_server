// SRV-1312: the source of a portable record reads only the caller's own
// submission, in one transaction, and checks every row. Two invented
// students: the owner gets the rows, the other student the same not_found as
// an unknown id (C-23). Every token, id and text below is invented.
import { describe, expect, it } from "vitest";

import { digestSubmissionReceiptPayloadV2 } from "../../domain/index.ts";
import { PAYLOAD, sourceOf, TEXT } from "../../../test-support/portable-record/index.ts";
import type { ActorTransaction, WithActor } from "../index.ts";

import { createPortableRecordReader } from "./portable-record.ts";

const OWNER = "izmisljeni-token-studentice-a-000000000000001";
const OTHER = "izmisljeni-token-studenta-b-0000000000000002";
const ID = PAYLOAD.submissionId;

type Row = Record<string, unknown>;

async function database(change: { receipt?: Row; text?: Row; key?: Row } = {}) {
  const source = await sourceOf();
  const receipt: Row = {
    outcome: "found",
    payload: source.receiptPayload,
    digest: source.payloadDigestSha256,
    signature: source.signature,
    ...change.receipt,
  };
  const text: Row = { outcome: "found", revision: "7", body: TEXT, ...change.text };
  const key: Row = {
    outcome: "match",
    keyBase64Url: (source.key as { keyBase64Url: string }).keyBase64Url,
    domain: PAYLOAD.evidenceDomainId,
    purpose: "receipt",
    validFrom: "2026-11-19T00:00:00.000Z",
    validTo: null,
    revokedAt: null,
    ...change.key,
  };
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  let transactions = 0;
  const withActor = (async (token, fn) => {
    transactions += 1;
    const tx: ActorTransaction = {
      async query(sql, values) {
        seen.push({ token, text: sql, values });
        let rows: Row[];
        if (sql.includes("app.read_submission_receipt")) {
          // As the function: only the principal of the submission gets its receipt.
          rows = [token === OWNER && values?.[0] === ID ? receipt : { outcome: "not_found" }];
        } else if (sql.includes("app.read_work_export")) {
          rows = [text];
        } else {
          rows = [key];
        }
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { read: createPortableRecordReader(withActor), seen, transactions: () => transactions };
}

describe("createPortableRecordReader", () => {
  it("gives the owner the receipt, the submitted text and the key, in one transaction", async () => {
    const db = await database();
    const source = await sourceOf();
    expect(await db.read(OWNER, ID)).toEqual({
      status: "found",
      rows: {
        receiptPayload: source.receiptPayload,
        payloadDigestSha256: source.payloadDigestSha256,
        signature: source.signature,
        key: source.key,
        text: TEXT,
      },
    });
    expect(db.transactions()).toBe(1);
    expect(db.seen.map((call) => call.values)).toEqual([
      [ID],
      [PAYLOAD.documentId, PAYLOAD.revision],
      [ID, PAYLOAD.artifactSha256],
    ]);
    expect(db.seen.every((call) => call.token === OWNER)).toBe(true);
  });

  it("answers another student, an unknown and a malformed id with the same not_found", async () => {
    const db = await database();
    expect(await db.read(OTHER, ID)).toEqual({ status: "not_found" });
    expect(await db.read(OWNER, "00000000-0000-4000-8000-000000000009")).toEqual({
      status: "not_found",
    });
    expect(await db.read(OWNER, "nije-uuid")).toEqual({ status: "not_found" });
    expect(await db.read(OWNER, ID.toUpperCase())).toEqual({ status: "not_found" });
    // The other student's read never got past the receipt.
    expect(db.seen.filter((call) => call.token === OTHER)).toHaveLength(1);
  });

  it("answers a submission without a receipt and a practice work as not_found", async () => {
    expect(await (await database({ receipt: { outcome: "none" } })).read(OWNER, ID)).toEqual({
      status: "not_found",
    });
    expect(await (await database({ text: { outcome: "not_found" } })).read(OWNER, ID)).toEqual({
      status: "not_found",
    });
  });

  it("maps no session to unauthenticated", async () => {
    expect(
      await (await database({ receipt: { outcome: "unauthorized" } })).read(OWNER, ID),
    ).toEqual({ status: "unauthenticated" });
    const thrown = Object.assign(new Error("no session"), { code: "ZD401" });
    const read = createPortableRecordReader((async () => {
      throw thrown;
    }) as WithActor);
    expect(await read(OWNER, ID)).toEqual({ status: "unauthenticated" });
    const other = createPortableRecordReader((async () => {
      throw new Error("database down");
    }) as WithActor);
    await expect(other(OWNER, ID)).rejects.toThrow("database down");
  });

  it("refuses rows it cannot vouch for, naming only a closed reason", async () => {
    const other = await digestSubmissionReceiptPayloadV2({
      ...PAYLOAD,
      submissionId: "00000000-0000-4000-8000-0000000000b2",
    });
    const cases: [Parameters<typeof database>[0], string][] = [
      [{ receipt: { payload: "{" } }, "receipt_malformed"],
      [{ receipt: { payload: other.canonical } }, "receipt_malformed"],
      [{ receipt: { digest: "x" } }, "receipt_malformed"],
      [{ receipt: { signature: null } }, "receipt_malformed"],
      [{ receipt: { outcome: "other" } }, "receipt_malformed"],
      [{ text: { revision: "6" } }, "text_malformed"],
      [{ text: { body: "" } }, "text_malformed"],
      [{ key: { outcome: "no_match" } }, "key_malformed"],
      [{ key: { validFrom: "2026-11-19" } }, "key_malformed"],
      [{ key: { domain: "nije-uuid" } }, "key_malformed"],
      [{ key: { keyBase64Url: "a+b" } }, "key_malformed"],
    ];
    for (const [change, reason] of cases) {
      expect(await (await database(change)).read(OWNER, ID), JSON.stringify(change)).toEqual({
        status: "unavailable",
        reason,
      });
    }
  });
});

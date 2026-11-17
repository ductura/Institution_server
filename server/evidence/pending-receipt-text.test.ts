// DAN-820 820c-1, plan of attack ductura/server#146 P-1: a pending receipt
// text yields a payload only as a valid v2 payload that is its own JCS form
// and carries the row's id; anything else is refused with a closed reason.
// The table "refused" is ported from Ductus sign-pending-receipt.test.ts at
// 333e163 with the same assertions; the input classes are new (the property
// is in pending-receipt-text.property.test.ts).
import { describe, expect, it } from "vitest";

import { canonicalizeJcs } from "../domain/index.ts";
import { PAYLOAD, RECEIPT, ROW, TEXT } from "../../test-support/pending-receipt/index.ts";

import { MAX_PENDING_RECEIPT_TEXT_LENGTH, parsePendingReceipt } from "./pending-receipt-text.ts";

const parse = (receiptId: unknown, text: unknown) =>
  parsePendingReceipt({ receiptId, receiptPayloadText: text } as never);
const jcs = (change: Record<string, unknown>) => canonicalizeJcs({ ...PAYLOAD, ...change });

describe("parsePendingReceipt refuses every text that is not the row's own v2 payload (P-1)", () => {
  const refused: [string, unknown, unknown, string][] = [
    ["K2 not JSON", RECEIPT, "{", "receipt_malformed"],
    ["K2 empty", RECEIPT, "", "receipt_malformed"],
    ["K2 not a string", RECEIPT, 7, "receipt_malformed"],
    ["K2 over the length cap", RECEIPT, " ".repeat(16_385), "receipt_malformed"],
    ["K2 extra field", RECEIPT, jcs({ extra: 1 }), "receipt_malformed"],
    [
      "K2 acceptedAt with seconds",
      RECEIPT,
      jcs({ acceptedAt: "2026-10-19T06:00:07.000Z" }),
      "receipt_malformed",
    ],
    [
      "K2 row id is not the payload's",
      "00000000-0000-4000-8000-0000000000c2",
      TEXT,
      "receipt_id_mismatch",
    ],
    [
      "K2 lone surrogate escape",
      RECEIPT,
      TEXT.replace('"doc-1"', '"doc-\\ud800"'),
      "receipt_malformed",
    ],
    ["K3 not its JCS form", RECEIPT, JSON.stringify(PAYLOAD, null, 1), "not_canonical"],
    ["K3 trailing newline", RECEIPT, `${TEXT}\n`, "not_canonical"],
    [
      "K3 duplicate key that parsing drops",
      RECEIPT,
      `{"documentId":"doc-9",${TEXT.slice(1)}`,
      "not_canonical",
    ],
    [
      "K4 receipt v1",
      RECEIPT,
      jcs({ receiptSchema: "ductus-evidence-receipt-v1" }),
      "unsupported_schema",
    ],
  ];
  it.each(refused)("%s", (_, receiptId, text, reason) => {
    expect(parse(receiptId, text)).toEqual({ ok: false, reason });
  });

  // New: the input classes, each with the outcome pinned per field.
  it.each(["\t", "\r", "\n", "\r\n"])("a raw %j inside a string is not JSON", (ch) => {
    expect(parse(RECEIPT, TEXT.replace('"doc-1"', `"doc-1${ch}"`))).toEqual({
      ok: false,
      reason: "receipt_malformed",
    });
  });
  it.each(["\t", "\r\n", "\u007f"])("an escaped %j in clientTransactionId is malformed", (ch) => {
    expect(parse(RECEIPT, jcs({ clientTransactionId: `tx-1${ch}` }))).toEqual({
      ok: false,
      reason: "receipt_malformed",
    });
  });
  it.each(["__proto__", "toString", "constructor"])("%s as an own key of the payload", (key) => {
    const text = TEXT.replace("{", `{${JSON.stringify(key)}:1,`);
    expect(parse(RECEIPT, text)).toMatchObject({ ok: false });
  });
  it("the length cap is asked before the text is parsed", () => {
    expect(parse(RECEIPT, `${TEXT}${" ".repeat(MAX_PENDING_RECEIPT_TEXT_LENGTH)}`)).toEqual({
      ok: false,
      reason: "receipt_malformed",
    });
  });
});

describe("controls: the row's own payload", () => {
  it("the stored text is the payload", () => {
    expect(parsePendingReceipt(ROW)).toEqual({ ok: true, payload: PAYLOAD });
  });
  // Pinned as the domain's v2 rules answer today: only clientTransactionId
  // refuses a control character; the other text fields carry it (see PR).
  it.each([" ", "\u007f", "\t", "\r\n"])("documentId with %j is the payload's own value", (ch) => {
    const read = parse(RECEIPT, jcs({ documentId: `doc-1${ch}` }));
    expect(read).toEqual({ ok: true, payload: { ...PAYLOAD, documentId: `doc-1${ch}` } });
  });
  it("NBSP in clientTransactionId is no control character", () => {
    expect(parse(RECEIPT, jcs({ clientTransactionId: "tx-1 " }))).toMatchObject({ ok: true });
  });
});

// SRV-1502 (M3.2, B-9): the worker's read of the segment object a pending
// receipt names answers the port's shape, `not_found` for no row, or
// `unavailable` with a closed code; never the driver's text and never a row
// of another form. Every identifier below is invented.
import { describe, expect, it } from "vitest";

import { createPendingReceiptObjectSource } from "./receipt-object.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const RECEIPT = "00000000-0000-4000-8000-0000000000a1";
const ROW = {
  institution_id: "00000000-0000-4000-8000-0000000000c1",
  evidence_package_id: "paket-izmisljeni-1",
  segment_hash: "ab".repeat(32),
  payload_bytes: 512,
  storage_ref: "s3://izmisljeno.invalid/objekt",
};
const OBJECT = {
  institutionId: ROW.institution_id,
  evidencePackageId: ROW.evidence_package_id,
  segmentHash: ROW.segment_hash,
  payloadBytes: ROW.payload_bytes,
  storageRef: ROW.storage_ref,
};

function source(answer: () => unknown) {
  const calls: { text: string; values: unknown }[] = [];
  const db = {
    query: async (text: string, values: unknown) => {
      calls.push({ text, values });
      return answer();
    },
  };
  return { made: createPendingReceiptObjectSource(db as never), calls };
}

describe("createPendingReceiptObjectSource", () => {
  it("reads one row of app.worker_receipt_object with the two ids as parameters", async () => {
    const { made, calls } = source(() => ({ rows: [ROW] }));
    await expect(made.receiptObject(DOMAIN, RECEIPT)).resolves.toEqual({
      status: "ok",
      object: OBJECT,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain("app.worker_receipt_object($1::uuid, $2::uuid)");
    expect(calls[0]?.values).toEqual([DOMAIN, RECEIPT]);
  });

  it("answers not_found when the database has no row", async () => {
    const { made } = source(() => ({ rows: [] }));
    await expect(made.receiptObject(DOMAIN, RECEIPT)).resolves.toEqual({ status: "not_found" });
  });

  it.each([
    ["a domain that is no uuid", "domena", RECEIPT],
    ["a receipt that is no uuid", DOMAIN, "potvrda"],
    ["an uppercase receipt id", DOMAIN, RECEIPT.toUpperCase()],
    ["a missing receipt", DOMAIN, undefined],
  ])("refuses %s before the database", async (_, domain, receipt) => {
    const { made, calls } = source(() => ({ rows: [ROW] }));
    await expect(made.receiptObject(domain as never, receipt as never)).resolves.toEqual({
      status: "unavailable",
      reason: "request_invalid",
    });
    expect(calls).toHaveLength(0);
  });

  it("closes a driver error to database_error without its text", async () => {
    const { made } = source(() => {
      throw new Error("postgres://korisnik:tajna@izmisljeno.invalid/baza");
    });
    const read = await made.receiptObject(DOMAIN, RECEIPT);
    expect(read).toEqual({ status: "unavailable", reason: "database_error" });
    expect(JSON.stringify(read)).not.toContain("tajna");
  });

  it.each([
    ["no rows array", {}],
    ["two rows", { rows: [ROW, ROW] }],
    ["an extra column", { rows: [{ ...ROW, extra: 1 }] }],
    [
      "a missing column",
      { rows: [{ ...ROW, storage_ref: undefined }].map(({ storage_ref, ...r }) => r) },
    ],
    ["an institution that is no uuid", { rows: [{ ...ROW, institution_id: "ustanova" }] }],
    ["an empty package", { rows: [{ ...ROW, evidence_package_id: "" }] }],
    ["a hash that is no string", { rows: [{ ...ROW, segment_hash: 1 }] }],
    ["a byte count as text", { rows: [{ ...ROW, payload_bytes: "512" }] }],
    ["a fractional byte count", { rows: [{ ...ROW, payload_bytes: 1.5 }] }],
    ["an empty reference", { rows: [{ ...ROW, storage_ref: "" }] }],
  ])("answers row_malformed for %s", async (_, answer) => {
    const { made } = source(() => answer);
    await expect(made.receiptObject(DOMAIN, RECEIPT)).resolves.toEqual({
      status: "unavailable",
      reason: "row_malformed",
    });
  });
});

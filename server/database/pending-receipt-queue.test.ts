// DAN-820 820b-1, plan of attack ductura/server#146 S-2, S-3, S-5, S-6: the
// worker's read of the pending receipts returns the port's shape or a closed
// code, never a partial list, an error text or a receipt id in the backlog.
// Every identifier and payload below is invented.
import { describe, expect, it } from "vitest";

import { createPendingReceiptQueue } from "./pending-receipt-queue.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const DOMAIN2 = "00000000-0000-4000-8000-0000000000d2";
const R1 = "00000000-0000-1000-0000-0000000000a1";
const R2 = "00000000-0000-4000-8000-0000000000a2";
const PAYLOAD = '{"receiptSchema":"ductus-evidence-receipt-v2"}';
const AT = "2026-11-16T10:00:00.000Z";
const RECEIPT = { receipt_id: R1, receipt_payload: PAYLOAD };
const BACKLOG = { evidence_domain_id: DOMAIN, pending_count: "3", oldest_created_at: AT };

function queue(answer: () => unknown) {
  const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
  const db = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return answer();
    },
  };
  return { q: createPendingReceiptQueue(db as never), calls };
}
const rows = (...list: unknown[]) => queue(() => ({ rows: list }));

const BAD_IDS: unknown[] = [
  "",
  R2.toUpperCase(),
  ` ${R2}`,
  `${R2}\n`,
  `${R2}\r\n`,
  `${R2}\t`,
  `${R2} `,
  `${R2}\u007f`,
  `{${R2}}`,
  `urn:uuid:${R2}`,
  R2.replaceAll("-", ""),
  R2.slice(1),
  `${R2}0`,
  R2.replace("a2", "g2"),
  undefined,
  42,
  {},
];

describe("pendingReceipts refuses a request before the database (S-3)", () => {
  it.each([0, 101, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "10", null])(
    "limit %s",
    async (limit) => {
      const { q, calls } = rows(RECEIPT);
      expect(await q.pendingReceipts(DOMAIN, limit as number, null)).toEqual({
        status: "unavailable",
        reason: "request_invalid",
      });
      expect(calls).toEqual([]);
    },
  );

  it.each([...BAD_IDS, null, R1])("domain %j", async (domain) => {
    const { q, calls } = rows(RECEIPT);
    const read = await q.pendingReceipts(domain as string, 10, null);
    expect(read).toEqual({ status: "unavailable", reason: "request_invalid" });
    expect(calls).toEqual([]);
  });

  it.each(BAD_IDS)("afterReceiptId %j", async (after) => {
    const { q, calls } = rows(RECEIPT);
    const read = await q.pendingReceipts(DOMAIN, 10, after as string);
    expect(read).toEqual({ status: "unavailable", reason: "request_invalid" });
    expect(calls).toEqual([]);
  });

  it.each([
    [1, null],
    [100, R1],
    [100, R2],
  ])("controls: limit %s after %s pass unchanged, in one statement", async (limit, after) => {
    const { q, calls } = rows(RECEIPT);
    expect(await q.pendingReceipts(DOMAIN, limit, after)).toEqual({
      status: "ok",
      rows: [{ receiptId: R1, receiptPayloadText: PAYLOAD }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain(
      "app.worker_pending_receipts($1::uuid, $2::integer, $3::uuid)",
    );
    expect(calls[0]?.values).toEqual([DOMAIN, limit, after]);
  });
});

const inherited = Object.assign(Object.create({ receipt_payload: PAYLOAD }) as object, {
  receipt_id: R1,
});
const ownProto = JSON.parse(`{"receipt_id":"${R1}","receipt_payload":"x","__proto__":{}}`);

describe("an unexpected answer makes the whole read row_malformed (S-2)", () => {
  it.each([
    ["no rows array", () => ({})],
    ["rows null", () => ({ rows: null })],
    ["rows not an array", () => ({ rows: { 0: RECEIPT } })],
    ["not an object", () => ({ rows: [RECEIPT, "x"] })],
    ["null row", () => ({ rows: [null] })],
    ["array row", () => ({ rows: [[R1, PAYLOAD]] })],
    ["missing column", () => ({ rows: [{ receipt_id: R1 }] })],
    ["extra column", () => ({ rows: [{ ...RECEIPT, evidence_domain_id: DOMAIN }] })],
    ["inherited column", () => ({ rows: [inherited] })],
    ["own __proto__", () => ({ rows: [ownProto] })],
    ["own toString", () => ({ rows: [{ ...RECEIPT, toString: "x" }] })],
    ["id not a uuid", () => ({ rows: [{ ...RECEIPT, receipt_id: R1.toUpperCase() }] })],
    ["id repeated", () => ({ rows: [RECEIPT, RECEIPT] })],
    ["payload not text", () => ({ rows: [{ ...RECEIPT, receipt_payload: {} }] })],
    ["payload empty", () => ({ rows: [{ ...RECEIPT, receipt_payload: "" }] })],
    [
      "more than limit",
      () => ({
        rows: [RECEIPT, { ...RECEIPT, receipt_id: R2 }, { ...RECEIPT, receipt_id: DOMAIN }],
      }),
    ],
  ])("pendingReceipts: %s", async (_name, answer) => {
    const { q } = queue(answer);
    const read = await q.pendingReceipts(DOMAIN, 2, null);
    expect(read).toEqual({ status: "unavailable", reason: "row_malformed" });
  });

  it.each<[string, Record<string, unknown>]>([
    ["domain null", { evidence_domain_id: null }],
    ["domain not a uuid", { evidence_domain_id: DOMAIN.toUpperCase() }],
    ...["0", "01", "1e3", " 1", "1 ", "-1", "9007199254740993", "", 3].map(
      (n): [string, Record<string, unknown>] => [
        `count ${JSON.stringify(n)}`,
        { pending_count: n },
      ],
    ),
    ...[new Date(AT), "2026-11-16T10:00:00.000+00", "2026-11-16T10:00:00.000", "", null].map(
      (t): [string, Record<string, unknown>] => [
        `time ${JSON.stringify(t)}`,
        { oldest_created_at: t },
      ],
    ),
    // Out of range in every field: a rolled-over date (30 February) parses to
    // another day, the rest do not parse at all and must not throw (Codex P2).
    ...[
      "2026-02-30T10:00:00.000Z",
      "2026-13-16T10:00:00.000Z",
      "2026-00-16T10:00:00.000Z",
      "2026-11-00T10:00:00.000Z",
      "2026-11-32T10:00:00.000Z",
      "2026-11-16T25:00:00.000Z",
      "2026-11-16T10:60:00.000Z",
      "2026-11-16T10:00:60.000Z",
    ].map((t): [string, Record<string, unknown>] => [
      `no such time ${t}`,
      { oldest_created_at: t },
    ]),
    ["receipt id in it (S-6)", { receipt_id: R1 }],
    ["payload in it (S-6)", { receipt_payload: PAYLOAD }],
  ])("backlog: %s", async (_name, change) => {
    const { q } = rows({ ...BACKLOG, ...change });
    expect(await q.backlog()).toEqual({ status: "unavailable", reason: "row_malformed" });
  });

  it("backlog: a domain repeated", async () => {
    const { q } = rows(BACKLOG, BACKLOG);
    expect(await q.backlog()).toEqual({ status: "unavailable", reason: "row_malformed" });
  });
});

describe("a driver failure is a code only (S-5)", () => {
  const secret = "postgres://worker:tajna-lozinka@db.invalid/ductus";
  it.each([new Error(`connect failed ${secret}`), secret, undefined])("throws %s", async (e) => {
    const { q } = queue(() => {
      throw e;
    });
    for (const read of [await q.backlog(), await q.pendingReceipts(DOMAIN, 10, null)]) {
      expect(read).toEqual({ status: "unavailable", reason: "database_error" });
      expect(JSON.stringify(read)).not.toContain("tajna");
    }
  });
});

describe("backlog (S-6)", () => {
  it("holds only the domain, the count and the oldest time, in camelCase", async () => {
    const { q, calls } = rows(BACKLOG, { ...BACKLOG, evidence_domain_id: DOMAIN2 });
    expect(await q.backlog()).toEqual({
      status: "ok",
      rows: [
        { evidenceDomainId: DOMAIN, pendingCount: 3, oldestCreatedAt: AT },
        { evidenceDomainId: DOMAIN2, pendingCount: 3, oldestCreatedAt: AT },
      ],
    });
    expect(calls).toEqual([
      { text: expect.stringContaining("app.worker_pending_backlog()"), values: [] },
    ]);
  });

  it("an empty backlog and an empty list are ok", async () => {
    const { q } = rows();
    expect(await q.backlog()).toEqual({ status: "ok", rows: [] });
    expect(await q.pendingReceipts(DOMAIN, 100, null)).toEqual({ status: "ok", rows: [] });
  });
});

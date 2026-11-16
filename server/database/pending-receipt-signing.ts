// The worker's port of the pending receipts (DAN-820, VS-1b part 1, 820b-1).
// Port of Ductus src/application/ports/pending-receipt-signing.ts at 333e163,
// the read half: the rows, the reads and PendingReceiptQueue, word for word,
// with `type` for `interface` (docs/CODE_STYLE.md 4). The write half
// (ReceiptKeysRead, AttachReceiptSignatureCommand, its outcome and
// PendingReceiptStore) comes with its adapter in 820b-2.

/**
 * One row of `app.worker_pending_receipts`: a v2 receipt with no signature
 * yet, as the text the database stores. The text, not a parsed copy, is what
 * the database hashes when it checks the digest of a signature.
 */
export type PendingReceiptRow = {
  receiptId: string;
  receiptPayloadText: string;
};

/**
 * One row of `app.worker_pending_backlog`: how many receipts of one domain
 * wait for a signature, and since when by the database clock (ISO 8601).
 * No receipt id or payload is in it (plan #1021 P-10, P-20).
 */
export type PendingBacklogRow = {
  evidenceDomainId: string;
  pendingCount: number;
  oldestCreatedAt: string;
};

export type PendingBacklogRead =
  { status: "ok"; rows: readonly PendingBacklogRow[] } | { status: "unavailable"; reason: string };

export type PendingReceiptsRead =
  { status: "ok"; rows: readonly PendingReceiptRow[] } | { status: "unavailable"; reason: string };

/**
 * The worker's read side of the pending receipts: the backlog per domain and
 * at most 100 pending v2 receipts of one domain, oldest first
 * (`app.worker_pending_receipts`). With `afterReceiptId` the list starts
 * after that receipt in the same order (created_at, id); null, or a receipt
 * of another domain, starts at the oldest. Only the worker process holds it
 * (D-71, D-102).
 */
export type PendingReceiptQueue = {
  backlog(): Promise<PendingBacklogRead>;
  pendingReceipts(
    evidenceDomainId: string,
    limit: number,
    afterReceiptId: string | null,
  ): Promise<PendingReceiptsRead>;
};

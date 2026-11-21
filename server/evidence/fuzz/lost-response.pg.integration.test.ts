import { readFileSync } from "node:fs";

import { expect, it, vi } from "vitest";

import { createTestDatabase } from "../../../test-support/database/index.ts";
import { DOMAIN, testSigner } from "../../../test-support/pending-receipt/index.ts";
import { createEvidenceCommitter, createWorkOpener, type WithActor } from "../../database/index.ts";
import {
  canonicalizeJcs,
  EDIT_STEP_FORMAT_V1,
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  revisionZeroDocument,
  sha256WebCrypto,
} from "../../domain/index.ts";
import { InMemoryEvidencePayloadStore } from "../../external/storage/index.ts";
import { createEvidenceService, type EvidenceCommitRequestOutcome } from "../index.ts";

const INSTITUTION_FIXTURE = new URL(
  "../../../db/main/tests/fixtures/institution.inc",
  import.meta.url,
);
const KEY_ID = "kljuc-izmisljeni-1506";
const STUDENT_TOKEN = "D".repeat(43);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const TRANSACTION = "tx-izmisljeni-1506";
const TEXT = "Izmišljeni odlomak o ljetnoj kiši.";
const ENCODER = new TextEncoder();

it("returns the same signed receipt after a lost response and records the evidence once", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(readFileSync(INSTITUTION_FIXTURE, "utf8"));
    const signer = testSigner(KEY_ID);
    await db.exec("SET LOCAL ROLE ductus_evidence");
    await db.query(
      "INSERT INTO evidence.domain (id, institution_id, region) VALUES ($1, pg_temp.id('fak_a'), 'eu-central-1')",
      [DOMAIN],
    );
    await db.query(
      `INSERT INTO evidence.signing_key (key_id, key_version, evidence_domain_id, institution_id,
         purpose, algorithm, key_base64url, valid_from)
       VALUES ($1, '1', $2, pg_temp.id('fak_a'), 'receipt', 'Ed25519', $3,
         date_trunc('minute', now()) - interval '1 day')`,
      [KEY_ID, DOMAIN, signer.key().keyBase64Url],
    );
    await db.exec("RESET ROLE");

    // Use the production adapters under the app role inside the rollback-only test transaction.
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(sql, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    const opener = createWorkOpener(withActor);
    const opened = await opener.openWork(STUDENT_TOKEN, ASSIGNMENT, true);
    if (!opened.ok) throw new Error(opened.error.code);
    const { documentId, documentHash, evidenceProfileId } = opened.value;
    expect(opened.value.currentRevision).toBe(0);

    const document = revisionZeroDocument();
    const paragraph = document.nodes[0]!;
    if (paragraph.type !== "paragraph") throw new Error("expected a paragraph at revision zero");
    paragraph.children.push({ type: "text", text: TEXT, marks: [] });
    const snapshot = canonicalizeJcs(document);
    const finalHash = await sha256WebCrypto(snapshot);
    const segment = canonicalizeJcs({
      evidenceSchema: EVIDENCE_SEGMENT_SCHEMA_V2,
      canonicalization: EVIDENCE_CANONICALIZATION_V2,
      hashAlgorithm: EVIDENCE_HASH_ALGORITHM_V2,
      documentId,
      sessionId: "sesija-izmisljena-1506",
      segmentId: "odsjecak-izmisljeni-1506",
      sequenceFrom: 1,
      sequenceTo: 1,
      observedStartedAt: "2026-11-21T10:00:00.000Z",
      observedEndedAt: "2026-11-21T10:00:00.000Z",
      initialDocumentHash: documentHash,
      finalDocumentHash: finalHash,
      predecessorSegmentHash: null,
      events: [
        {
          sequence: 1,
          source: "editor",
          steps: [
            {
              stepType: "replace",
              from: 1,
              to: 1,
              slice: { content: [{ type: "text", text: TEXT }] },
            },
          ],
          touchedNodeIds: [paragraph.id],
          beforeDocumentHash: documentHash,
          afterDocumentHash: finalHash,
        },
      ],
      captureContext: { editorModel: "prosemirror", transactionFormat: EDIT_STEP_FORMAT_V1 },
      evidenceProfileId,
    });
    const request = {
      documentId,
      clientTransactionId: TRANSACTION,
      baseRevision: 0,
      segment: ENCODER.encode(segment),
      document: ENCODER.encode(snapshot),
    };
    const payloads = new InMemoryEvidencePayloadStore();
    const put = vi.spyOn(payloads, "putImmutable");
    const service = createEvidenceService({
      committer: createEvidenceCommitter(withActor, signer.provider),
      payloads,
    });

    const lostResponse = new Error("simulated lost response");
    const serverReplies: EvidenceCommitRequestOutcome[] = [];
    async function send() {
      const reply = await service.commit(STUDENT_TOKEN, request);
      serverReplies.push(reply);
      if (serverReplies.length === 1) throw lostResponse;
      return reply;
    }
    async function stored() {
      const { rows } = await db.query(
        `SELECT
           (SELECT count(*)::int FROM evidence.document_revision
             WHERE document_id = $1 AND revision > 0) AS revisions,
           (SELECT count(*)::int FROM evidence.segment WHERE document_id = $1) AS segments,
           (SELECT count(*)::int FROM evidence.receipt r
             JOIN evidence.package p ON p.id = r.evidence_package_id AND p.institution_id = r.institution_id
             WHERE p.document_id = $1) AS receipts`,
        [documentId],
      );
      return rows[0];
    }

    await expect(send()).rejects.toBe(lostResponse);
    const accepted = serverReplies[0];
    expect(accepted).toMatchObject({
      status: "committed",
      revision: 1,
      signedReceipt: expect.any(Object),
    });
    const acceptedCounts = await stored();
    expect(acceptedCounts).toEqual({ revisions: 1, segments: 1, receipts: 1 });

    const retry = await send();
    expect(retry).toEqual({ ...accepted, status: "duplicate" });
    expect(JSON.stringify(retry)).toBe(
      JSON.stringify(accepted).replace('"status":"committed"', '"status":"duplicate"'),
    );
    expect(await stored()).toEqual(acceptedCounts);
    expect(payloads.size).toBe(1);
    expect(put).toHaveBeenCalledTimes(1);
    expect(signer.provider.sign).toHaveBeenCalledTimes(1);
  } finally {
    await db.close();
  }
});

// INT-18 (A07) over the migrated PostgreSQL and the real HTTP app: a commit
// whose answer the client never reads, and a deferred receipt whose signing
// worker dies inside the attach, each end with exactly one revision and one
// receipt, counted in the database, and the client's retry with the same
// clientTransactionId and the same bytes gets that receipt back. The
// production adapters run under SET LOCAL ROLE ductus_app (the commit) and
// ductus_worker (the worker) inside the rollback-only test transaction; every
// person, document and key is invented (db/main/tests/fixtures).
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { expect, it } from "vitest";

import {
  createActorReader,
  createPendingReceiptObjectSource,
  createPendingReceiptQueue,
  createPendingReceiptStore,
  createSettingsWriter,
  createWebAuthnCredentials,
  createWorkOpener,
  type WithActor,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  EDIT_STEP_FORMAT_V1,
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  type EvidenceDomainKey,
  revisionZeroDocument,
  sha256WebCrypto,
  verifySignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";
import { InMemoryEvidencePayloadStore } from "../../server/external/storage/index.ts";
import {
  createDatabases,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createLayers,
  startServer,
} from "../../server/http/index.ts";
import { createLogger } from "../../server/log/index.ts";
import { createReceiptSigningWorker } from "../../server/worker/index.ts";
import { createTestDatabase, type TestDatabase } from "../../test-support/database/index.ts";
import { DOMAIN, testSigner } from "../../test-support/pending-receipt/index.ts";

const INSTITUTION_FIXTURE = new URL(
  "../../db/main/tests/fixtures/institution.inc",
  import.meta.url,
);
const ORIGIN = "https://ductura.example.invalid";
const KEY_ID = "kljuc-izmisljeni-int18";
const ANA = "D".repeat(43);
const Z1 = "00000000-0000-4000-8000-0000000000a1";
const TEXT = "Izmišljeni odlomak o jesenskoj magli.";

type Answer = { status: number; body: Record<string, unknown> };
type Stored = { revisions: number; segments: number; receipts: number };

/** Ana's database: the institution fixture, fak-a's evidence domain and the signing key. */
async function prepare(db: TestDatabase, signer: ReturnType<typeof testSigner>) {
  await db.exec(readFileSync(INSTITUTION_FIXTURE, "utf8"));
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
}

/** The app login: the session token, then every statement as ductus_app. */
function appActor(db: TestDatabase): WithActor {
  return async (token, run) => {
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
}

function mainOver(withActor: WithActor) {
  return {
    withActor,
    actorReader: createActorReader(withActor),
    workOpener: createWorkOpener(withActor),
    settingsWriter: createSettingsWriter(withActor),
    webauthnCredentials: createWebAuthnCredentials(withActor),
  };
}

/**
 * One POST as the browser sends it. With `lose`, the client drops the
 * connection as soon as the answer starts, without reading a byte of it: the
 * server has done its work, the client only knows that nothing came back.
 */
function post(
  port: number,
  path: string,
  body: unknown,
  protocol: string,
  lose = false,
): Promise<Answer | "lost"> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "ductus-protocol": protocol,
          cookie: `__Host-ductus_session=${ANA}`,
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        if (lose) {
          res.destroy();
          resolve("lost");
          return;
        }
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Answer["body"] }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

async function answered(promise: Promise<Answer | "lost">): Promise<Answer> {
  const answer = await promise;
  if (answer === "lost") throw new Error("expected an answer");
  return answer;
}

/** Open Z1 over HTTP and build revision 1's segment and snapshot for it. */
async function firstRevision(port: number, protocol: string) {
  const opened = await answered(
    post(port, "/api/v1/evidence/open", { assignmentId: Z1, start: true }, protocol),
  );
  expect(opened.status).toBe(200);
  const { documentId, documentHash, evidenceProfileId, receiptKeys } = opened.body as {
    documentId: string;
    documentHash: string;
    evidenceProfileId: string;
    receiptKeys: EvidenceDomainKey[];
  };
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
    sessionId: "sesija-izmisljena-int18",
    segmentId: "odsjecak-izmisljeni-int18",
    sequenceFrom: 1,
    sequenceTo: 1,
    observedStartedAt: "2026-11-22T10:00:00.000Z",
    observedEndedAt: "2026-11-22T10:00:00.000Z",
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
    clientTransactionId: `tx-izmisljeni-int18-${protocol}`,
    baseRevision: 0,
    segments: [Buffer.from(segment, "utf8").toString("base64")],
    document: Buffer.from(snapshot, "utf8").toString("base64"),
  };
  return { documentId, receiptKeys, request };
}

/** Rows of the document, counted in the database as the superuser (no RLS). */
async function stored(db: TestDatabase, documentId: string): Promise<Stored> {
  const { rows } = await db.query<Stored>(
    `SELECT
       (SELECT count(*)::int FROM evidence.document_revision
         WHERE document_id = $1 AND revision > 0) AS revisions,
       (SELECT count(*)::int FROM evidence.segment WHERE document_id = $1) AS segments,
       (SELECT count(*)::int FROM evidence.receipt r
         JOIN evidence.package p ON p.id = r.evidence_package_id AND p.institution_id = r.institution_id
         WHERE p.document_id = $1) AS receipts`,
    [documentId],
  );
  return rows[0]!;
}

async function receiptRow(db: TestDatabase, documentId: string) {
  const { rows } = await db.query<{ status: string; signature: unknown }>(
    `SELECT r.status, r.signature FROM evidence.receipt r
       JOIN evidence.package p ON p.id = r.evidence_package_id AND p.institution_id = r.institution_id
      WHERE p.document_id = $1`,
    [documentId],
  );
  return rows;
}

/** The worker's login: every statement as ductus_worker; `failOn` is a death before it runs. */
function asWorker(db: TestDatabase, failOn?: (text: string) => boolean) {
  return {
    async query(text: string, values?: unknown[]) {
      if (failOn?.(text)) throw new Error("radnik je pao usred upisa potpisa");
      await db.exec("SET LOCAL ROLE ductus_worker");
      try {
        return await db.query(text, values);
      } finally {
        await db.exec("RESET ROLE");
      }
    },
  };
}

function workerOver(
  db: ReturnType<typeof asWorker>,
  signer: ReturnType<typeof testSigner>,
  payloads: InMemoryEvidencePayloadStore,
) {
  return createReceiptSigningWorker({
    queue: createPendingReceiptQueue(db as never),
    store: createPendingReceiptStore(db as never),
    objects: createPendingReceiptObjectSource(db as never),
    // The same store the commit wrote to: the worker's object check is real.
    locator: payloads,
    presence: payloads,
    signer: signer.provider,
    log: createLogger(() => {}),
    config: { signTimeoutMs: 5_000 },
  });
}

it("A07: izgubljen odgovor na commit i ponovljen isti zahtjev daju jednu reviziju i jednu potvrdu", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    const signer = testSigner(KEY_ID);
    await prepare(db, signer);
    const payloads = new InMemoryEvidencePayloadStore();
    const main = mainOver(appActor(db));
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [
        createEvidenceOpenRoute(main),
        createEvidenceCommitRouteFor(main, { signer: signer.provider, payloads }),
      ],
    });
    try {
      const { documentId, receiptKeys, request } = await firstRevision(server.port, "1");
      expect(await stored(db, documentId)).toEqual({ revisions: 0, segments: 0, receipts: 0 });

      // The first commit is done on the server; its answer never reaches the client.
      expect(await post(server.port, "/api/v1/evidence/commit", request, "1", true)).toBe("lost");
      expect(await stored(db, documentId)).toEqual({ revisions: 1, segments: 1, receipts: 1 });
      const [row] = await receiptRow(db, documentId);
      expect(row?.status).toBe("signed");

      // The client retries with the same clientTransactionId and the same bytes.
      const retry = await answered(post(server.port, "/api/v1/evidence/commit", request, "1"));
      expect(retry.status).toBe(200);
      expect(retry.body).toMatchObject({
        status: "duplicate",
        duplicate: true,
        revision: 1,
        receipt: { status: "signed" },
      });
      const signedReceipt = (retry.body.receipt as { signedReceipt: { signature: unknown } })
        .signedReceipt;
      // The receipt of the lost answer: the stored signature, valid under open's keys.
      expect(signedReceipt.signature).toStrictEqual(row?.signature);
      const verified = await verifySignedEvidenceReceiptV2(
        signedReceipt,
        {
          documentId,
          clientTransactionId: request.clientTransactionId,
          revision: 1,
          evidenceDomainId: DOMAIN,
        },
        receiptKeys,
      );
      expect(verified.ok).toBe(true);

      // A third send changes nothing either.
      const third = await answered(post(server.port, "/api/v1/evidence/commit", request, "1"));
      expect(third).toStrictEqual(retry);
      expect(await stored(db, documentId)).toEqual({ revisions: 1, segments: 1, receipts: 1 });
      expect(payloads.size).toBe(1);
      expect(signer.provider.sign).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

it("A07: radnik koji padne usred potpisa i nastavak potpisivanja daju jednu reviziju i jednu potpisanu potvrdu", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    const workerSigner = testSigner(KEY_ID);
    await prepare(db, workerSigner);
    // Protocol 2 signs in the worker only: the web process never signs.
    const webSigner = testSigner(KEY_ID);
    const payloads = new InMemoryEvidencePayloadStore();
    const main = mainOver(appActor(db));
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [
        createEvidenceOpenRoute(main),
        createEvidenceCommitRouteFor(main, {
          signer: webSigner.provider,
          payloads,
          asyncSigning: true,
        }),
      ],
    });
    try {
      const { documentId, receiptKeys, request } = await firstRevision(server.port, "2");
      const pending = { revision: 1, receipt: { status: "pending_signature" } };

      // The commit is accepted for deferred signing; its answer is lost.
      expect(await post(server.port, "/api/v1/evidence/commit", request, "2", true)).toBe("lost");
      expect(await stored(db, documentId)).toEqual({ revisions: 1, segments: 1, receipts: 1 });
      expect(await receiptRow(db, documentId)).toEqual([
        { status: "pending_signature", signature: null },
      ]);
      // The retry before any signature: the same commit, still pending.
      const early = await answered(post(server.port, "/api/v1/evidence/commit", request, "2"));
      expect(early.status).toBe(202);
      expect(early.body).toStrictEqual({ status: "duplicate", duplicate: true, ...pending });

      // The first worker signs, then dies inside the attach: nothing is stored.
      const dying = workerOver(
        asWorker(db, (text) => text.includes("worker_attach_receipt_signature")),
        workerSigner,
        payloads,
      );
      const died = await dying.runPass();
      expect(died?.summary.receipts.signed).toBe(0);
      expect(died?.summary.receipts.unavailable).toBe(1);
      expect(workerSigner.provider.sign).toHaveBeenCalledTimes(1);
      expect(await receiptRow(db, documentId)).toEqual([
        { status: "pending_signature", signature: null },
      ]);
      expect(await stored(db, documentId)).toEqual({ revisions: 1, segments: 1, receipts: 1 });
      const lostInput = workerSigner.inputs[0]!;

      // A retry while the receipt waits: still 202 pending, nothing new written.
      const waiting = await answered(post(server.port, "/api/v1/evidence/commit", request, "2"));
      expect(waiting).toStrictEqual(early);

      // A new worker resumes the signing and stores the signature over the same input.
      const fresh = workerOver(asWorker(db), workerSigner, payloads);
      const resumed = await fresh.runPass();
      expect(resumed?.summary.receipts.signed).toBe(1);
      expect(Buffer.from(workerSigner.inputs[1]!)).toEqual(Buffer.from(lostInput));
      const [row] = await receiptRow(db, documentId);
      expect(row?.status).toBe("signed");
      expect(row?.signature).toEqual(workerSigner.envelope(lostInput));
      expect(await stored(db, documentId)).toEqual({ revisions: 1, segments: 1, receipts: 1 });

      // The client's retry gets that one receipt, under either protocol.
      const after = await answered(post(server.port, "/api/v1/evidence/commit", request, "2"));
      expect(after.status).toBe(200);
      expect(after.body).toMatchObject({
        status: "duplicate",
        duplicate: true,
        revision: 1,
        receipt: { status: "signed" },
      });
      const signedReceipt = (after.body.receipt as { signedReceipt: { signature: unknown } })
        .signedReceipt;
      expect(signedReceipt.signature).toStrictEqual(row?.signature);
      const verified = await verifySignedEvidenceReceiptV2(
        signedReceipt,
        {
          documentId,
          clientTransactionId: request.clientTransactionId,
          revision: 1,
          evidenceDomainId: DOMAIN,
        },
        receiptKeys,
      );
      expect(verified.ok).toBe(true);
      const inline = await answered(post(server.port, "/api/v1/evidence/commit", request, "1"));
      expect(inline).toStrictEqual(after);

      expect(await stored(db, documentId)).toEqual({ revisions: 1, segments: 1, receipts: 1 });
      expect(await receiptRow(db, documentId)).toEqual([row]);
      expect(payloads.size).toBe(1);
      expect(webSigner.provider.sign).not.toHaveBeenCalled();
      expect(workerSigner.provider.sign).toHaveBeenCalledTimes(2);
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

// INT-17 (A04, F4-PM2-R10-SRV): the whole of K-4 over the migrated PostgreSQL
// and the real HTTP app, one story with no step replaced by a database insert:
// the teacher makes an assignment and an enrolment code, the student enrols,
// reads the notice and acknowledges it, writes and commits (evidence open and
// commit, a signed receipt), the teacher comments on that revision, the
// student submits it, and the student and the teacher open the same process
// summary. The two summaries are byte for byte one answer, and the document,
// the revision and the artifact hash are compared across the commit, the
// submission receipt and the rows. Not in this file: the offline writing
// (client journal) and the page that shows the summary (WEB, F4-PM2-R10).
// Fixture (db/main/tests/fixtures): Vesna (A) teaches K1 of fak-a, Boris (F)
// is a student of fak-a in no course, Dora (E) a student of K1, Tomo (J) a
// student of fak-b. Every person, text and key is invented.
import { readFileSync } from "node:fs";

import { expect, it } from "vitest";

import {
  createActorReader,
  createWorkOpener,
  type WithActor,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  EDIT_STEP_FORMAT_V1,
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  EVIDENCE_SEGMENT_SCHEMA_V2,
  revisionZeroDocument,
  sha256WebCrypto,
} from "../../server/domain/index.ts";
import { noticeFingerprint } from "../../server/domain/notice/index.ts";
import { DevelopmentEd25519SigningKeyProvider } from "../../server/external/keys/index.ts";
import { InMemoryEvidencePayloadStore } from "../../server/external/storage/index.ts";
import {
  createAcknowledgmentRouteFor,
  createCollaborationCommentsRouteFor,
  createDatabases,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createInstitutionAssignmentRoutesFor,
  createInstitutionCourseRoutesFor,
  createLayers,
  createProcessSummaryRouteFor,
  createStudentNoticeRouteFor,
  createStudentWriteRoutesFor,
  createSubmissionRouteFor,
  startServer,
} from "../../server/http/index.ts";
import { createTestDatabase, type TestDatabase } from "../../test-support/database/index.ts";
import { DOMAIN } from "../../test-support/pending-receipt/index.ts";

const INSTITUTION_FIXTURE = new URL(
  "../../db/main/tests/fixtures/institution.inc",
  import.meta.url,
);
const ORIGIN = "https://ductura.example.invalid";
const KEY_ID = "kljuc-izmisljeni-int17";
const VESNA = "A".repeat(43);
const DORA = "E".repeat(43);
const BORIS = "F".repeat(43);
const TOMO = "J".repeat(43);
const K1 = "00000000-0000-4000-8000-0000000000c1";
const TEXT = "Izmišljeni odlomak o jesenskoj magli.";

type Answer = { status: number; body: Record<string, unknown> };

/** One value of a nested answer, `undefined` where the path breaks. */
function dig(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (at, key) =>
      at !== null && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined,
    value,
  );
}

async function prepare(db: TestDatabase, signer: DevelopmentEd25519SigningKeyProvider) {
  const key = await signer.publicVerificationKey();
  if (!key.ok) throw new Error("no key");
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
    [KEY_ID, DOMAIN, key.value.keyBase64Url],
  );
  await db.exec("RESET ROLE");
}

function appActor(db: TestDatabase): WithActor {
  let last: Promise<unknown> = Promise.resolve();
  const one: WithActor = async (token, run) => {
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
  // One login at a time over the test's single connection.
  return (token, run) => {
    const next = last.then(
      () => one(token, run),
      () => one(token, run),
    );
    last = next.catch(() => undefined);
    return next;
  };
}

it("A04: puni K-4 od stvaranja zadatka i upisa do istog sažetka za studenta i nastavnika", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    const signer = new DevelopmentEd25519SigningKeyProvider(KEY_ID, "1");
    await prepare(db, signer);
    const payloads = new InMemoryEvidencePayloadStore();
    const withActor = appActor(db);
    const main = {
      withActor,
      actorReader: createActorReader(withActor),
      workOpener: createWorkOpener(withActor),
    } as never as Parameters<typeof createEvidenceOpenRoute>[0] &
      Parameters<typeof createEvidenceCommitRouteFor>[0];
    const deps = { signer, payloads };
    const server = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [
        ...createInstitutionCourseRoutesFor(main),
        ...createInstitutionAssignmentRoutesFor(main),
        ...createStudentWriteRoutesFor(main),
        createStudentNoticeRouteFor(main),
        createAcknowledgmentRouteFor(main),
        createEvidenceOpenRoute(main),
        createEvidenceCommitRouteFor(main, deps),
        createCollaborationCommentsRouteFor(main),
        createSubmissionRouteFor(main, deps),
        createProcessSummaryRouteFor(main, deps, {}),
      ],
    });
    const call = async (
      token: string,
      method: "GET" | "POST",
      path: string,
      body?: unknown,
    ): Promise<Answer> => {
      const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
        method,
        headers: {
          cookie: `__Host-ductus_session=${token}`,
          ...(method === "POST"
            ? {
                origin: ORIGIN,
                "sec-fetch-site": "same-origin",
                "content-type": "application/json",
                "ductus-protocol": "1",
              }
            : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text === "" ? {} : JSON.parse(text) };
    };
    try {
      // 1. The teacher makes the assignment and the enrolment code.
      const now = Date.now();
      const created = await call(VESNA, "POST", `/api/v1/institution/courses/${K1}/assignments`, {
        requestKey: "b15e6f70-8192-4da4-8eb5-f60718293a17",
        title: "Seminarski rad: izmišljena jesen",
        instructions: "Izmišljene upute za izmišljeni zadatak.",
        workType: "seminar_paper",
        opensAt: new Date(now - 3_600_000).toISOString(),
        dueAt: new Date(now + 30 * 86_400_000).toISOString(),
        aiPolicy: "prohibited",
        aiPurposes: [],
        evidenceProfile: "basic",
        importAllowed: false,
      });
      expect(created.status).toBe(201);
      const assignmentId = created.body["id"] as string;
      const code = await call(VESNA, "POST", `/api/v1/institution/courses/${K1}/enrollment-code`, {
        validUntil: new Date(now + 7 * 86_400_000).toISOString(),
      });
      expect(code.status).toBe(200);

      // 2. Before enrolling, Boris has no relation: the work is closed to him,
      // as to a stranger (C-23), and a student of another institution cannot enrol.
      const early = await call(BORIS, "GET", `/api/v1/student/assignments/${assignmentId}/notice`);
      expect(early.status).toBe(404);
      const foreign = await call(TOMO, "POST", "/api/v1/student/enrollments", {
        code: code.body["code"],
      });
      expect(foreign.body["outcome"]).not.toBe("enrolled");

      // 3. The student enrols, reads the notice and acknowledges that very version.
      const enrolled = await call(BORIS, "POST", "/api/v1/student/enrollments", {
        code: code.body["code"],
      });
      expect(enrolled).toMatchObject({ status: 200, body: { outcome: "enrolled", courseId: K1 } });
      const notice = await call(BORIS, "GET", `/api/v1/student/assignments/${assignmentId}/notice`);
      expect(notice.status).toBe(200);
      const n = notice.body;
      const fingerprint = await noticeFingerprint(
        n as unknown as Parameters<typeof noticeFingerprint>[0],
      );
      const acknowledged = await call(
        BORIS,
        "POST",
        `/api/v1/institution/assignments/${assignmentId}/acknowledgment`,
        { versionNo: n["versionNo"], fingerprint },
      );
      expect(acknowledged.status).toBe(200);

      // 4. The student writes and commits revision 1; the receipt is signed.
      const opened = await call(BORIS, "POST", "/api/v1/evidence/open", {
        assignmentId,
        start: true,
      });
      expect(opened.status).toBe(200);
      const { documentId, documentHash, evidenceProfileId } = opened.body as {
        documentId: string;
        documentHash: string;
        evidenceProfileId: string;
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
        sessionId: "sesija-izmisljena-int17",
        segmentId: "odsjecak-izmisljeni-int17",
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
      const committed = await call(BORIS, "POST", "/api/v1/evidence/commit", {
        documentId,
        clientTransactionId: "tx-izmisljeni-int17",
        baseRevision: 0,
        segments: [Buffer.from(segment, "utf8").toString("base64")],
        document: Buffer.from(snapshot, "utf8").toString("base64"),
      });
      expect(committed.status).toBe(200);
      expect(committed.body).toMatchObject({ revision: 1, receipt: { status: "signed" } });

      // 5. The teacher comments on that revision; a student of the course who
      // does not own the work cannot comment on it, nor read its summary.
      const comment = await call(VESNA, "POST", "/api/v1/comments/create", {
        anchor: null,
        body: "Izmišljeni opći komentar nastavnice.",
        documentId,
        revision: 1,
      });
      expect(comment.status).toBe(200);
      const stranger = await call(DORA, "POST", "/api/v1/comments/create", {
        anchor: null,
        body: "Izmišljeni komentar tuđeg studenta.",
        documentId,
        revision: 1,
      });
      // Whatever the route answers a stranger, it answers the same for a work that does not exist.
      const unknownComment = await call(DORA, "POST", "/api/v1/comments/create", {
        anchor: null,
        body: "Izmišljeni komentar tuđeg studenta.",
        documentId: "doc-nepostojeci",
        revision: 1,
      });
      expect(stranger.status).not.toBe(200);
      expect({ ...stranger.body, requestId: 0 }).toStrictEqual({
        ...unknownComment.body,
        requestId: 0,
      });
      const strangerSummary = await call(DORA, "POST", "/api/v1/process-summary", { documentId });
      const unknownSummary = await call(DORA, "POST", "/api/v1/process-summary", {
        documentId: "doc-nepostojeci",
      });
      expect(strangerSummary.status).toBe(404);
      expect(strangerSummary.body).toStrictEqual({
        ...unknownSummary.body,
        requestId: strangerSummary.body["requestId"],
      });

      // 6. The student submits revision 1; the receipt names the same work.
      const submitted = await call(BORIS, "POST", "/api/v1/submission", {
        documentId,
        revision: 1,
      });
      expect(submitted.status).toBe(200);
      expect(submitted.body["status"]).toBe("submitted");
      expect(dig(submitted.body, "receipt", "payload")).toMatchObject({
        documentId,
        revision: 1,
        assignmentId,
        evidencePackageId: dig(
          committed.body,
          "receipt",
          "signedReceipt",
          "payload",
          "evidencePackageId",
        ),
      });
      expect(dig(submitted.body, "receipt", "payload", "artifactSha256")).toContain(
        finalHash.replace(/^sha256:/, ""),
      );
      const { rows } = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM evidence.document_revision
          WHERE document_id = $1 AND revision = 1`,
        [documentId],
      );
      expect(rows[0]!.n).toBe(1);

      // 7. Both roles open the same summary: one answer, the same bytes.
      const own = await call(BORIS, "POST", "/api/v1/process-summary", { documentId });
      const teachers = await call(VESNA, "POST", "/api/v1/process-summary", { documentId });
      expect(own.status).toBe(200);
      expect(own.body["summaryFormat"]).toBe("ductus-process-summary-v1");
      expect(own.body["recordState"]).toBe("complete");
      expect(dig(own.body, "sessions", "count")).toBeGreaterThanOrEqual(1);
      expect(teachers.status).toBe(200);
      expect({ ...teachers.body, requestId: 0 }).toStrictEqual({ ...own.body, requestId: 0 });
    } finally {
      await server.close();
    }
  } finally {
    await db.close();
  }
});

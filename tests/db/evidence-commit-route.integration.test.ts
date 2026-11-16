import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createActorReader,
  createWithActor,
  createWorkOpener,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  type EvidenceDomainKey,
  verifySignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";
import {
  DEV_SIGNING_KEY_FILE,
  PersistentDevelopmentEd25519SigningKeyProvider,
} from "../../server/external/keys/index.ts";
import { InMemoryEvidencePayloadStore } from "../../server/external/storage/index.ts";
import {
  createDatabases,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// DAN-815 c, plan of attack ductura/server#119 parts D1, D2 and G3: open,
// commit and open again through a real server over real PostgreSQL with RLS,
// a ductus_app login, the development signer (NODE_ENV test only) and
// payload storage in memory. The segment is the invented golden segment
// rewritten for this run's document. Every institution, person, token and
// key is random and synthetic; the login exists only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_evidence_commit_route_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const id = {
  a: randomUUID(),
  adminA: randomUUID(),
  vesna: randomUUID(),
  ana: randomUUID(),
  k1: randomUUID(),
  z1: randomUUID(),
  domainA: randomUUID(),
};
const token = randomBytes(32).toString("base64url");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// The seed lives outside the repository, as the signer demands.
const seedDir = mkdtempSync(join(tmpdir(), "dan815-route-"));
const SEED = join(seedDir, "seed");
writeFileSync(SEED, randomBytes(32), { mode: 0o600 });
const signer = new PersistentDevelopmentEd25519SigningKeyProvider(
  { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: SEED },
  ROOT,
);
const payloads = new InMemoryEvidencePayloadStore();

type GoldenSegment = Record<string, unknown> & { events: Record<string, unknown>[] };
const { chain } = JSON.parse(
  readFileSync(join(ROOT, "server/domain/forensics/golden-vectors/evidence-v2.json"), "latin1"),
) as {
  chain: {
    segments: { segment: GoldenSegment }[];
    documentStates: { value: unknown }[];
  };
};

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;

async function fixture(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  await q("BEGIN");
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    id.a,
    `it-ecr-${suffix}`,
  ]);
  await q(
    `INSERT INTO institution.institution_settings
       (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Fakultet A (test)', 5, '15 minutes')`,
    [id.a],
  );
  for (const name of ["adminA", "vesna", "ana"] as const) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.test', $3, $4)`,
      [id[name], id.a, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
  }
  await q(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
    [token, id.ana, id.a],
  );
  await q("SELECT institution.appoint_institution_admin($1, $2)", [id.adminA, `Zahtjev ${suffix}`]);
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $3, now())`,
    [id.a, id.vesna, id.adminA],
  );
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
    [id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
     VALUES ($1, $2, $3, 'teacher'), ($1, $2, $4, 'student')`,
    [id.k1, id.a, id.vesna, id.ana],
  );
  await q(
    `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
     VALUES ($1, $2, $3, 1, $4)`,
    [id.z1, id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
       opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
     VALUES ($1, 1, 'Zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
       now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, $2)`,
    [id.z1, id.vesna],
  );
  await q(
    `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
     VALUES ($1, 1, $2, $3)`,
    [id.z1, id.ana, id.a],
  );
  await q(
    "INSERT INTO evidence.domain (id, institution_id, region) VALUES ($1, $2, 'eu-central-1')",
    [id.domainA, id.a],
  );
  const key = await signer.publicVerificationKey();
  if (!key.ok) throw new Error("development key");
  await q(
    `INSERT INTO evidence.signing_key
       (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
     VALUES ($1, $2, $3, $4, 'receipt', 'Ed25519', $5, date_trunc('minute', now()) - interval '1 day')`,
    [key.value.keyId, key.value.keyVersion, id.domainA, id.a, key.value.keyBase64Url],
  );
  await q("COMMIT");
}

beforeAll(async () => {
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [APP_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
  await fixture();
  const url = new URL(ADMIN_URL);
  url.username = APP_LOGIN;
  url.password = password;
  app = new pg.Pool({ connectionString: url.href, max: 4 });
  const withActor = createWithActor(app);
  const main = {
    withActor,
    actorReader: createActorReader(withActor),
    workOpener: createWorkOpener(withActor),
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createEvidenceOpenRoute(main),
      createEvidenceCommitRouteFor(main, { signer, payloads }),
    ],
  });
});

afterAll(async () => {
  await server?.close();
  await app?.end();
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  await admin.end();
  rmSync(seedDir, { recursive: true, force: true });
});

type Answer = { status: number; body: Record<string, unknown> & { [key: string]: unknown } };
function post(path: string, body: unknown): Promise<Answer> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method: "POST",
        path,
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          "ductus-protocol": "1",
          cookie: `__Host-ductus_session=${token}`,
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }));
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

describe("evidence/commit through a real server over real PostgreSQL", () => {
  it("D1, D2, G3: commits a segment with a receipt that verifies under open's keys; a retry is the same bytes; open reports the revision", async () => {
    const opened = await post("/api/v1/evidence/open", { assignmentId: id.z1, start: true });
    expect(opened.status).toBe(200);
    const { documentId, documentHash, evidenceProfileId, receiptKeys } = opened.body as {
      documentId: string;
      documentHash: string;
      evidenceProfileId: string;
      receiptKeys: EvidenceDomainKey[];
    };
    const template = chain.segments[0]!.segment;
    const document = canonicalizeJcs(chain.documentStates[1]!.value);
    const segment = canonicalizeJcs({
      ...template,
      documentId,
      sessionId: `sesija-${suffix}`,
      segmentId: `segment-${suffix}-1`,
      sequenceFrom: 1,
      sequenceTo: 1,
      initialDocumentHash: documentHash,
      finalDocumentHash: sha256(document),
      predecessorSegmentHash: null,
      evidenceProfileId,
      events: [
        {
          ...template.events[0],
          sequence: 1,
          beforeDocumentHash: documentHash,
          afterDocumentHash: sha256(document),
        },
      ],
    });
    const request = {
      documentId,
      clientTransactionId: `tx-${suffix}-1`,
      baseRevision: 0,
      segments: [Buffer.from(segment, "utf8").toString("base64")],
      document: Buffer.from(document, "utf8").toString("base64"),
    };

    const committed = await post("/api/v1/evidence/commit", request);
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({
      status: "committed",
      revision: 1,
      receipt: { status: "signed" },
    });
    const signedReceipt = (committed.body.receipt as { signedReceipt: unknown }).signedReceipt;
    const verified = await verifySignedEvidenceReceiptV2(
      signedReceipt,
      {
        documentId,
        clientTransactionId: request.clientTransactionId,
        revision: 1,
        evidenceDomainId: id.domainA,
      },
      receiptKeys,
    );
    expect(verified.ok).toBe(true);
    expect(payloads.size).toBe(1);

    const again = await post("/api/v1/evidence/commit", request);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("duplicate");
    expect(JSON.stringify((again.body.receipt as { signedReceipt: unknown }).signedReceipt)).toBe(
      JSON.stringify(signedReceipt),
    );
    expect(payloads.size).toBe(1);

    const reopened = await post("/api/v1/evidence/open", { assignmentId: id.z1 });
    expect(reopened.body).toMatchObject({
      status: "opened",
      documentId,
      currentRevision: 1,
      documentHash: sha256(document),
      headSegmentHash: sha256(segment),
      lastSequenceTo: 1,
    });
    expect(Buffer.from(String(reopened.body.document), "base64").toString("utf8")).toBe(document);
  });
});

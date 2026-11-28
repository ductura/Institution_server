import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createActorReader,
  createSettingsWriter,
  createWebAuthnCredentials,
  createWithActor,
  createWorkOpener,
} from "../../server/database/index.ts";
import { canonicalizeJcs } from "../../server/domain/index.ts";
import {
  DEV_SIGNING_KEY_FILE,
  PersistentDevelopmentEd25519SigningKeyProvider,
} from "../../server/external/keys/index.ts";
import { InMemoryEvidencePayloadStore } from "../../server/external/storage/index.ts";
import {
  createDatabases,
  createEvidenceCommitRouteFor,
  createEvidenceOpenRoute,
  createEvidenceReplayRouteFor,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// DAN-818 c, attack plan ductura/server#136 A and C: open, commit and replay
// through a real server over real PostgreSQL with RLS and a ductus_app login
// (never an admin connection as the proof of a read, PLAN-MIGRACIJE §4a-1).
// The owner and the teacher of the assignment get the same bytes; another
// student of the course and a student of another institution get the same
// 404 as a work that does not exist, and storage is never read for them.
// Every institution, person, token and key is random and synthetic; the
// login exists only while this file runs.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_evidence_replay_route_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const id = {
  a: randomUUID(),
  b: randomUUID(),
  adminA: randomUUID(),
  vesna: randomUUID(),
  petra: randomUUID(),
  ana: randomUUID(),
  ivo: randomUUID(),
  marko: randomUUID(),
  k1: randomUUID(),
  z1: randomUUID(),
  domainA: randomUUID(),
};
const tokens = {
  ana: randomBytes(32).toString("base64url"),
  ivo: randomBytes(32).toString("base64url"),
  vesna: randomBytes(32).toString("base64url"),
  petra: randomBytes(32).toString("base64url"),
  marko: randomBytes(32).toString("base64url"),
};
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// The seed lives outside the repository, as the signer demands.
const seedDir = mkdtempSync(join(tmpdir(), "dan818-route-"));
const SEED = join(seedDir, "seed");
writeFileSync(SEED, randomBytes(32), { mode: 0o600 });
const signer = new PersistentDevelopmentEd25519SigningKeyProvider(
  { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: SEED },
  ROOT,
);
const payloads = new InMemoryEvidencePayloadStore();
let storageReads = 0;
// When set, storage hands back these bytes for every object: a corrupt store (#136 C14).
let corruptBytes: Uint8Array | null = null;
const readImmutable = payloads.readImmutable.bind(payloads);
payloads.readImmutable = (input) => {
  storageReads += 1;
  if (corruptBytes !== null) return Promise.resolve({ status: "found", bytes: corruptBytes });
  return readImmutable(input);
};

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
    `it-err-${suffix}`,
  ]);
  await q(
    `INSERT INTO institution.institution_settings
       (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Fakultet A (test)', 5, '15 minutes')`,
    [id.a],
  );
  const accounts: [string, string][] = (["adminA", "vesna", "petra", "ana", "ivo"] as const).map(
    (name) => [id[name], name] as [string, string],
  );
  for (const [user, name] of accounts) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.test', $3, $4)`,
      [user, id.a, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
  }
  for (const name of ["ana", "ivo", "vesna", "petra"] as const) {
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [tokens[name], id[name], id.a],
    );
  }
  await q("SELECT institution.appoint_institution_admin($1, $2)", [id.adminA, `Zahtjev ${suffix}`]);
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $3, now())`,
    [id.a, id.vesna, id.adminA],
  );
  // A teacher of the same institution with no tie to the course (attack plan #136 A3).
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $3, now())`,
    [id.a, id.petra, id.adminA],
  );
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
    [id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'teacher' UNION ALL SELECT $1::uuid, $2::uuid, unnest($4::uuid[]), 'student'`,
    [id.k1, id.a, id.vesna, [id.ana, id.ivo]],
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
     SELECT $1::uuid, 1, unnest($2::uuid[]), $3::uuid`,
    [id.z1, [id.ana, id.ivo], id.a],
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
  // Another institution with a student of its own (attack plan #136 A2).
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    id.b,
    `it-err-b-${suffix}`,
  ]);
  await q(
    `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
     VALUES ($1, $2, 'https://issuer.test', $3, $4)`,
    [id.marko, id.b, `sub-marko-${suffix}`, `marko-${suffix}@fak-b.invalid`],
  );
  await q(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
    [tokens.marko, id.marko, id.b],
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
    settingsWriter: createSettingsWriter(withActor),
    webauthnCredentials: createWebAuthnCredentials(withActor),
  };
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createEvidenceOpenRoute(main),
      createEvidenceCommitRouteFor(main, { signer, payloads }),
      createEvidenceReplayRouteFor(main, { payloads }),
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

type Answer = { status: number; text: string; body: Record<string, unknown> };
function post(path: string, body: unknown, who: string | null): Promise<Answer> {
  const text = JSON.stringify(body);
  const cookie: Record<string, string> =
    who === null ? {} : { cookie: `__Host-ductus_session=${who}` };
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
          ...cookie,
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, text: data, body: JSON.parse(data) }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
const replay = (body: unknown, who: string | null) => post("/api/v1/evidence/replay", body, who);

describe("evidence/replay through a real server over real PostgreSQL", () => {
  let documentId = "";
  let segment = "";
  let start = "";

  beforeAll(async () => {
    const opened = await post(
      "/api/v1/evidence/open",
      { assignmentId: id.z1, start: true },
      tokens.ana,
    );
    expect(opened.status).toBe(200);
    const body = opened.body as {
      documentId: string;
      documentHash: string;
      evidenceProfileId: string;
      document: string;
    };
    documentId = body.documentId;
    start = Buffer.from(body.document, "base64").toString("utf8");
    const template = chain.segments[0]!.segment;
    const document = canonicalizeJcs(chain.documentStates[1]!.value);
    segment = canonicalizeJcs({
      ...template,
      documentId,
      sessionId: `sesija-${suffix}`,
      segmentId: `segment-${suffix}-1`,
      sequenceFrom: 1,
      sequenceTo: 1,
      initialDocumentHash: body.documentHash,
      finalDocumentHash: sha256(document),
      predecessorSegmentHash: null,
      evidenceProfileId: body.evidenceProfileId,
      events: [
        {
          ...template.events[0],
          sequence: 1,
          beforeDocumentHash: body.documentHash,
          afterDocumentHash: sha256(document),
        },
      ],
    });
    const committed = await post(
      "/api/v1/evidence/commit",
      {
        documentId,
        clientTransactionId: `tx-${suffix}-1`,
        baseRevision: 0,
        segments: [Buffer.from(segment, "utf8").toString("base64")],
        document: Buffer.from(document, "utf8").toString("base64"),
      },
      tokens.ana,
    );
    expect(committed.status).toBe(200);
  });

  it("the owner reads the first page: the stored segment bytes and the document before them, as JCS", async () => {
    const page = await replay({ documentId, from: 0 }, tokens.ana);
    expect(page.status).toBe(200);
    expect(page.body).toEqual({
      replayFormat: "ductus-evidence-replay-v1",
      segmentCount: 1,
      head: { segmentHash: sha256(segment), segmentCount: 1 },
      from: 0,
      next: null,
      startDocument: start,
      segments: [segment],
      resumeDocuments: {},
      resolutions: {},
    });
    expect(page.text).toBe(canonicalizeJcs(page.body));
  });

  it("A3: the teacher of the assignment gets the same bytes (PRODUCT §5 rule 5)", async () => {
    const owner = await replay({ documentId, from: 0 }, tokens.ana);
    const teacher = await replay({ documentId, from: 0 }, tokens.vesna);
    expect(teacher.status).toBe(200);
    expect(teacher.text).toBe(owner.text);
  });

  it("A1, A2, A3: another student of the course, a teacher not of the course and a student of another institution get the 404 of a missing work; storage is not read", async () => {
    const missing = await replay(
      { documentId: `dokument-nepostojeci-${suffix}`, from: 0 },
      tokens.ana,
    );
    expect(missing).toMatchObject({ status: 404, body: { status: "not_found" } });
    const before = storageReads;
    for (const who of [tokens.ivo, tokens.petra, tokens.marko]) {
      const answer = await replay({ documentId, from: 0 }, who);
      expect(answer.status).toBe(404);
      expect(answer.text).toBe(missing.text);
    }
    expect(storageReads).toBe(before);
  });

  it("A7: a foreign reader with a head that is not the record's still gets 404, never 409", async () => {
    const head = { segmentHash: "0".repeat(64), segmentCount: 2 };
    expect((await replay({ documentId, from: 1, head }, tokens.marko)).status).toBe(404);
    expect((await replay({ documentId, from: 1, head }, tokens.ana)).status).toBe(409);
  });

  it("C19: a page past the pinned end is 404; the pinned head of the record itself is read", async () => {
    const head = { segmentHash: sha256(segment), segmentCount: 1 };
    expect((await replay({ documentId, from: 1, head }, tokens.ana)).status).toBe(404);
  });

  it("A6: no session cookie and an unknown session are 401", async () => {
    expect((await replay({ documentId, from: 0 }, null)).status).toBe(401);
    const unknown = await replay({ documentId, from: 0 }, randomBytes(32).toString("base64url"));
    expect(unknown).toMatchObject({ status: 401, body: { status: "unauthenticated" } });
  });
  it("C14: an object that is not the listed segment is 503 storage, never 404 or a page", async () => {
    corruptBytes = new TextEncoder().encode(segment.replace("sesija-", "sesijA-"));
    try {
      const answer = await replay({ documentId, from: 0 }, tokens.ana);
      expect(answer).toMatchObject({
        status: 503,
        body: { status: "unavailable", stage: "storage" },
      });
      expect(answer.text).not.toContain("sesij");
    } finally {
      corruptBytes = null;
    }
  });

  it("C19: a record that grows between pages is read up to the pinned head; a fresh first page sees the new head", async () => {
    const pinned = (await replay({ documentId, from: 0 }, tokens.ana)).body.head as {
      segmentHash: string;
      segmentCount: number;
    };
    const template = chain.segments[0]!.segment;
    const before = canonicalizeJcs(chain.documentStates[1]!.value);
    const after = canonicalizeJcs(chain.documentStates[2]!.value);
    const second = canonicalizeJcs({
      ...template,
      documentId,
      sessionId: `sesija-${suffix}`,
      segmentId: `segment-${suffix}-2`,
      sequenceFrom: 2,
      sequenceTo: 2,
      initialDocumentHash: sha256(before),
      finalDocumentHash: sha256(after),
      predecessorSegmentHash: sha256(segment),
      evidenceProfileId: (JSON.parse(segment) as { evidenceProfileId: string }).evidenceProfileId,
      events: [
        {
          ...template.events[1],
          sequence: 2,
          beforeDocumentHash: sha256(before),
          afterDocumentHash: sha256(after),
        },
      ],
    });
    const committed = await post(
      "/api/v1/evidence/commit",
      {
        documentId,
        clientTransactionId: `tx-${suffix}-2`,
        baseRevision: 1,
        segments: [Buffer.from(second, "utf8").toString("base64")],
        document: Buffer.from(after, "utf8").toString("base64"),
      },
      tokens.ana,
    );
    expect(committed.status).toBe(200);
    // The old pin still holds: nothing past it is served, never a page of two records.
    expect((await replay({ documentId, from: 1, head: pinned }, tokens.ana)).status).toBe(404);
    const fresh = await replay({ documentId, from: 0 }, tokens.ana);
    expect(fresh.body).toMatchObject({
      segmentCount: 2,
      head: { segmentHash: sha256(second), segmentCount: 2 },
      segments: [segment, second],
      next: null,
    });
    const head = fresh.body.head;
    const later = await replay({ documentId, from: 1, head }, tokens.vesna);
    expect(later.body).toMatchObject({ from: 1, segments: [second], startDocument: null });
  });
  it("F4-EDI-R05-SRV (B2): a stored resolution is on the page of its segment, the same bytes for owner and teacher", async () => {
    // Written as the commit with a resolution writes it (B1): revision 2, kept over revision 0.
    const second = (await replay({ documentId, from: 0 }, tokens.ana)).body.head as {
      segmentHash: string;
      segmentCount: number;
    };
    const written = await admin.query(
      `INSERT INTO evidence.revision_resolution (receipt_id, evidence_package_id, institution_id,
         principal_id, document_id, revision, conflict_base_revision, kind, created_at)
       SELECT r.id, r.evidence_package_id, r.institution_id, $3, $1, 2, 0, 'keep_local', now()
         FROM evidence.receipt r WHERE r.institution_id = $2 AND r.payload_sha256 = $4`,
      [documentId, id.a, id.ana, second.segmentHash],
    );
    expect(written.rowCount).toBe(1);
    const resolved = { [second.segmentHash]: { kind: "keep_local", conflictBaseRevision: 0 } };
    const owner = await replay({ documentId, from: 0 }, tokens.ana);
    const teacher = await replay({ documentId, from: 0 }, tokens.vesna);
    expect(owner.status).toBe(200);
    expect(owner.body.resolutions).toEqual(resolved);
    expect(teacher.text).toBe(owner.text);
    expect(owner.text).toBe(canonicalizeJcs(owner.body));
    // A later page names its own segment.
    const later = await replay({ documentId, from: 1, head: second }, tokens.vesna);
    expect(later.body).toMatchObject({ from: 1, resolutions: resolved });
    // A reader who may not see the work still gets the answer of a missing one.
    for (const who of [tokens.ivo, tokens.petra, tokens.marko]) {
      expect((await replay({ documentId, from: 0 }, who)).status).toBe(404);
    }
  });
  it("F4-EDI-R05-SRV (B3): a commit with a resolution through the route is on the replay page; a wrong base or a changed retry writes nothing", async () => {
    const first = JSON.parse(segment) as { evidenceProfileId: string };
    const head = (await replay({ documentId, from: 0 }, tokens.ana)).body.head as {
      segmentHash: string;
      segmentCount: number;
    };
    const template = chain.segments[1]!.segment;
    const before = canonicalizeJcs(chain.documentStates[2]!.value);
    const after = canonicalizeJcs(chain.documentStates[3]!.value);
    const third = canonicalizeJcs({
      ...template,
      documentId,
      sessionId: `sesija-${suffix}`,
      segmentId: `segment-${suffix}-3`,
      sequenceFrom: 3,
      sequenceTo: 3,
      initialDocumentHash: sha256(before),
      finalDocumentHash: sha256(after),
      predecessorSegmentHash: head.segmentHash,
      evidenceProfileId: first.evidenceProfileId,
      events: [
        {
          ...template.events[0],
          sequence: 3,
          beforeDocumentHash: sha256(before),
          afterDocumentHash: sha256(after),
        },
      ],
    });
    const body = (resolution: unknown) => ({
      documentId,
      clientTransactionId: `tx-${suffix}-3`,
      baseRevision: 2,
      segments: [Buffer.from(third, "utf8").toString("base64")],
      document: Buffer.from(after, "utf8").toString("base64"),
      ...(resolution === undefined ? {} : { resolution }),
    });
    // The base the commit is written on resolves no conflict: 422, and nothing is stored.
    const equal = await post(
      "/api/v1/evidence/commit",
      body({ kind: "keep_local", conflictBaseRevision: 2 }),
      tokens.ana,
    );
    expect(equal).toMatchObject({ status: 422, body: { status: "invalid" } });
    expect((await replay({ documentId, from: 0 }, tokens.ana)).body.segmentCount).toBe(2);

    const keep = { kind: "keep_local", conflictBaseRevision: 1 };
    const committed = await post("/api/v1/evidence/commit", body(keep), tokens.ana);
    expect(committed).toMatchObject({ status: 200, body: { status: "committed", revision: 3 } });
    // The same request again is the same answer; without the resolution, or with another
    // base M, it is another request: 409, and the stored resolution stays as it was.
    const again = await post("/api/v1/evidence/commit", body(keep), tokens.ana);
    expect(again).toMatchObject({ status: 200, body: { duplicate: true, revision: 3 } });
    const changed = await post("/api/v1/evidence/commit", body(undefined), tokens.ana);
    expect(changed).toMatchObject({ status: 409, body: { status: "txid_reused" } });
    const otherBase = await post(
      "/api/v1/evidence/commit",
      body({ kind: "keep_local", conflictBaseRevision: 0 }),
      tokens.ana,
    );
    expect(otherBase).toMatchObject({ status: 409, body: { status: "txid_reused" } });
    expect((await replay({ documentId, from: 0 }, tokens.ana)).body.segmentCount).toBe(3);

    const stored = await admin.query(
      `SELECT revision::int AS revision, conflict_base_revision::int AS base, kind FROM evidence.revision_resolution
        WHERE document_id = $1 AND revision >= 3`,
      [documentId],
    );
    expect(stored.rows).toEqual([{ revision: 3, base: 1, kind: "keep_local" }]);

    const owner = await replay({ documentId, from: 0 }, tokens.ana);
    const teacher = await replay({ documentId, from: 0 }, tokens.vesna);
    expect(owner.body).toMatchObject({ segmentCount: 3, head: { segmentHash: sha256(third) } });
    expect(owner.body.resolutions).toEqual({
      [head.segmentHash]: { kind: "keep_local", conflictBaseRevision: 0 },
      [sha256(third)]: keep,
    });
    expect(teacher.text).toBe(owner.text);
    expect(owner.text).toBe(canonicalizeJcs(owner.body));
  });
});

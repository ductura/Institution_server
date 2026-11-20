import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { seedStatements } from "../../scripts/lokalno/index.ts";
import {
  createActorReader,
  createSettingsWriter,
  createWebAuthnCredentials,
  createWithActor,
  createWorkOpener,
} from "../../server/database/index.ts";
import {
  canonicalizeJcs,
  type EvidenceDomainKey,
  verifyCanonicalEvidencePayloadV2,
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
  createEvidenceReplayRouteFor,
  createLayers,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// SRV-16 (Ductus#2028 c.7008147932): the whole evidence flow over the work of
// the local seed (db/main/local/seed.sql, SRV-01). demo-student opens the
// seeded work, commits an invented document of several block types as one
// evidence-v2 segment, gets a receipt signed with Ed25519 that verifies under
// the keys open hands out, and the replay returns bytes whose chain ends in the
// JCS hash of exactly that document. Refused: a document with a field the
// schema does not know (B-8) and a segment whose final hash is not the
// document's. SRV-33: the same flow over a document v2 (a source and a
// citation) on a v2 work, which the test makes itself for an invented student
// (no seed), and each version refused on a work of the other. The seed and
// the v2 fixture are idempotent, so a rerun continues the same works from
// their current heads. Development signer only (NODE_ENV test); its seed is
// random and lives outside the repository. Every person and text is invented.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_evidence_tok_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const ISSUER = "http://localhost:8090";
const TITLE = "Seminarski rad: kućno kompostiranje";
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const token = randomBytes(32).toString("base64url");
/** The session of the invented student of the v2 work (SRV-33). */
const tokenV2 = randomBytes(32).toString("base64url");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
/** The same hash with its last character changed. */
const broken = (hash: string) => `${hash.slice(0, -1)}${hash.endsWith("0") ? "1" : "0"}`;
const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

const seedDir = mkdtempSync(join(tmpdir(), "srv16-tok-"));
writeFileSync(join(seedDir, "seed"), randomBytes(32), { mode: 0o600 });
const signer = new PersistentDevelopmentEd25519SigningKeyProvider(
  { NODE_ENV: "test", [DEV_SIGNING_KEY_FILE]: join(seedDir, "seed") },
  ROOT,
);
const payloads = new InMemoryEvidencePayloadStore();
const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });

/**
 * The payloads of earlier runs over the same database, which the replay of a
 * later segment reads too: kept under tmpdir per cluster and database, loaded
 * into the store before the server starts, and every new one written there.
 */
async function keepPayloads(): Promise<void> {
  const { rows } = await admin.query<{ id: string }>(
    "SELECT system_identifier::text || '-' || current_database() AS id FROM pg_control_system()",
  );
  const dir = join(tmpdir(), "ductura-srv16-payloads", rows[0]!.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  type Put = Parameters<typeof payloads.putImmutable>[0];
  const put = payloads.putImmutable.bind(payloads);
  for (const file of readdirSync(dir)) {
    await put(JSON.parse(readFileSync(join(dir, file), "utf8")) as Put);
  }
  payloads.putImmutable = async (input: Put) => {
    const stored = await put(input);
    if (stored.status === "stored") {
      writeFileSync(join(dir, `${input.segmentHash}.json`), JSON.stringify(input), { mode: 0o600 });
    }
    return stored;
  };
}
/**
 * SRV-33: the v2 work, made as app.open_student_work makes a work, but from the
 * v2 revision 0 (evidence.revision_zero_document_v2()), which no route makes
 * yet (step 2 of document v2 §7). An invented student signs in through the
 * login function with `$2` as the session, enrols with the seed's code,
 * confirms the notice of the seeded assignment `$1`, and gets the work; on a
 * rerun only the session is new. Every name is invented. The two values reach
 * the block as settings of its own transaction.
 */
const V2_WORK_FIXTURE = `
DO $v2$
DECLARE
  c_issuer constant text := 'http://localhost:8090';
  c_home_org constant text := 'demo.ductus.test';
  c_subject constant text := 'srv16-v2-student';
  v_assignment uuid := current_setting('srv16.assignment')::uuid;
  v_token text := current_setting('srv16.token');
  v_course uuid;
  v_user uuid;
  v_institution uuid;
  v_version integer;
  v_outcome text;
  v_domain uuid;
  v_project text := gen_random_uuid()::text;
  v_document text := gen_random_uuid()::text;
BEGIN
  SET LOCAL ROLE ductus_auth;
  PERFORM identity.open_session(c_issuer, c_subject, 'srv16-v2@' || c_home_org, c_home_org,
                                sha256(convert_to(v_token, 'UTF8')), 'Iva', 'Primjerić', false);
  RESET ROLE;
  SELECT u.id, u.institution_id INTO STRICT v_user, v_institution FROM identity.user_account u
   WHERE u.oidc_issuer = c_issuer AND u.oidc_subject = c_subject;
  SELECT a.course_id, a.current_version INTO STRICT v_course, v_version
    FROM institution.assignment a WHERE a.id = v_assignment;

  SET LOCAL ROLE ductus_app;
  PERFORM set_config('app.session_token', v_token, true);
  IF institution.actor_course_role(v_course) IS NULL THEN
    SELECT e.outcome INTO v_outcome FROM institution.enroll_with_code('UPIS2026DEMO') e;
    IF v_outcome IS DISTINCT FROM 'enrolled' THEN
      RAISE EXCEPTION 'the v2 student was not enrolled (%)', v_outcome;
    END IF;
  END IF;
  IF NOT institution.has_acknowledged_current(v_assignment) THEN
    PERFORM institution.acknowledge_notice(v_assignment, v_version, 1);
  END IF;
  RESET ROLE;

  IF EXISTS (SELECT 1 FROM evidence.project p WHERE p.assignment_id = v_assignment
              AND p.institution_id = v_institution AND p.principal_id = v_user) THEN
    RETURN;
  END IF;
  SELECT d.id INTO STRICT v_domain FROM evidence.domain d WHERE d.institution_id = v_institution;
  INSERT INTO evidence.project (id, institution_id, assignment_id, principal_id)
  VALUES (v_project, v_institution, v_assignment, v_user);
  INSERT INTO evidence.document (id, institution_id, project_id, principal_id, current_revision, current_content_hash)
  VALUES (v_document, v_institution, v_project, v_user, 0,
          encode(sha256(convert_to(evidence.revision_zero_document_v2(), 'UTF8')), 'hex'));
  INSERT INTO evidence.document_revision (document_id, institution_id, revision, principal_id, content_hash)
  SELECT d.id, d.institution_id, 0, d.principal_id, d.current_content_hash
    FROM evidence.document d WHERE d.id = v_document;
  INSERT INTO evidence.document_checkpoint (document_id, institution_id, revision, body)
  VALUES (v_document, v_institution, 0, evidence.revision_zero_document_v2());
  INSERT INTO evidence.package (
    id, institution_id, evidence_domain_id, document_id, project_id, principal_id, evidence_profile_id,
    max_payload_bytes
  ) VALUES (gen_random_uuid()::text, v_institution, v_domain, v_document, v_project, v_user,
            'standard-v1', 2097152);
END
$v2$;`;

let app: pg.Pool;
let server: Running;
let assignmentId: string;
let domainId: string;

// An invented seminar text, as the editor records it: the blocks go in at the
// start of the document as one replace, then each new block gets its id. The
// ids are new on every run, so a rerun over the same database only adds.
type Block = { type: "heading" | "paragraph" | "bulletItem" | "quote"; text: string };
const BLOCKS: Block[] = [
  { type: "heading", text: "Kućno kompostiranje u gradu" },
  { type: "paragraph", text: "Izmišljeno kućanstvo u neboderu kompostira ostatke povrća." },
  { type: "bulletItem", text: "manje otpada u spremniku" },
  { type: "bulletItem", text: "zemlja za lončanice" },
  { type: "quote", text: "Kompost je spor, ali strpljiv." },
];
/** The block with italic text, to carry a mark through the record. */
const ITALIC = 1;

/** The document after one event that writes BLOCKS before `start`, and the event's steps. */
function written(start: { schemaVersion: number; nodes: { id: string }[] }) {
  const ids = BLOCKS.map(() => randomUUID());
  const nodes = BLOCKS.map((block, i) => {
    const children = [{ type: "text", text: block.text, marks: i === ITALIC ? ["italic"] : [] }];
    return block.type === "heading"
      ? { type: "heading", id: ids[i]!, level: 1, children }
      : { type: block.type, id: ids[i]!, children };
  });
  const slice = BLOCKS.map((block, i) => ({
    type: block.type,
    attrs: block.type === "heading" ? { level: 1, nodeId: null } : { nodeId: null },
    content: [
      { type: "text", text: block.text, ...(i === ITALIC ? { marks: [{ type: "italic" }] } : {}) },
    ],
  }));
  // ProseMirror positions: a text block takes its UTF-16 length plus two.
  let pos = 0;
  const named = BLOCKS.map((block, i) => {
    const step = { stepType: "attr", attr: "nodeId", pos, value: ids[i]! };
    pos += block.text.length + 2;
    return step;
  });
  return {
    document: canonicalizeJcs({ ...start, nodes: [...nodes, ...start.nodes] }),
    steps: [{ stepType: "replace", from: 0, to: 0, slice: { content: slice } }, ...named],
    touched: [...ids].sort(),
  };
}

type Answer = { status: number; body: Record<string, unknown>; text: string };
function post(path: string, body: unknown, session = token): Promise<Answer> {
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
          cookie: `__Host-ductus_session=${session}`,
          "content-length": String(Buffer.byteLength(text)),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), text: data }),
        );
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

beforeAll(async () => {
  await admin.query(seedStatements(readFileSync(join(ROOT, "db/main/local/seed.sql"), "utf8")));
  const { rows } = await admin.query<{
    student: string;
    institution: string;
    assignment: string;
    domain: string;
  }>(
    `SELECT u.id AS student, u.institution_id AS institution, a.id AS assignment, d.id AS domain
       FROM identity.user_account u
       JOIN identity.institution i ON i.id = u.institution_id AND i.slug = 'demo-fakultet'
       JOIN institution.assignment a ON a.institution_id = i.id
       JOIN institution.assignment_version v ON v.assignment_id = a.id AND v.version_no = a.current_version
       JOIN evidence.domain d ON d.institution_id = i.id
      WHERE u.oidc_issuer = $1 AND u.oidc_subject = 'demo-student' AND v.title = $2`,
    [ISSUER, TITLE],
  );
  expect(rows).toHaveLength(1);
  const seeded = rows[0]!;
  assignmentId = seeded.assignment;
  domainId = seeded.domain;
  await admin.query(
    `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
     VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
    [token, seeded.student, seeded.institution],
  );
  const fixture = await admin.connect();
  try {
    await fixture.query("BEGIN");
    await fixture.query(
      "SELECT set_config('srv16.assignment', $1, true), set_config('srv16.token', $2, true)",
      [assignmentId, tokenV2],
    );
    await fixture.query(V2_WORK_FIXTURE);
    await fixture.query("COMMIT");
  } catch (error) {
    await fixture.query("ROLLBACK");
    throw error;
  } finally {
    fixture.release();
  }
  const key = await signer.publicVerificationKey();
  if (!key.ok) throw new Error("development key");
  await admin.query(
    `INSERT INTO evidence.signing_key
       (key_id, key_version, evidence_domain_id, institution_id, purpose, algorithm, key_base64url, valid_from)
     VALUES ($1, $2, $3, $4, 'receipt', 'Ed25519', $5, date_trunc('minute', now()) - interval '1 day')`,
    [key.value.keyId, key.value.keyVersion, domainId, seeded.institution, key.value.keyBase64Url],
  );

  await keepPayloads();
  await admin.query(`DROP ROLE IF EXISTS ${APP_LOGIN}`);
  const ddl = await admin.query<{ ddl: string }>(
    "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L IN ROLE ductus_app', $1::text, $2::text) AS ddl",
    [APP_LOGIN, password],
  );
  await admin.query(ddl.rows[0]!.ddl);
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

type Opened = {
  status: string;
  documentId: string;
  documentHash: string;
  document: string;
  evidenceProfileId: string;
  currentRevision: number;
  headSegmentHash: string | null;
  lastSequenceTo: number;
  receiptKeys: EvidenceDomainKey[];
};
type Segment = Record<string, unknown> & { events: Record<string, unknown>[] };

const open = async (session = token) =>
  (await post("/api/v1/evidence/open", { assignmentId }, session)).body as Opened;

/** One commit of `content` over the work as `opened` left it, by a segment that ends in `claimed`. */
async function commitOver(
  opened: Opened,
  content: Document,
  claimed = sha256(content.document),
  session = token,
) {
  const { chain } = JSON.parse(
    readFileSync(join(ROOT, "server/domain/forensics/golden-vectors/evidence-v2.json"), "latin1"),
  ) as { chain: { segments: { segment: Segment }[] } };
  const template = chain.segments[0]!.segment;
  const sequence = opened.lastSequenceTo + 1;
  const segment = canonicalizeJcs({
    ...template,
    documentId: opened.documentId,
    sessionId: `sesija-srv16-${suffix}`,
    segmentId: `segment-srv16-${randomUUID()}`,
    sequenceFrom: sequence,
    sequenceTo: sequence,
    initialDocumentHash: opened.documentHash,
    finalDocumentHash: claimed,
    predecessorSegmentHash: opened.headSegmentHash,
    evidenceProfileId: opened.evidenceProfileId,
    events: [
      {
        ...template.events[0],
        sequence,
        source: "editor",
        steps: content.steps,
        touchedNodeIds: content.touched,
        beforeDocumentHash: opened.documentHash,
        afterDocumentHash: claimed,
      },
    ],
  });
  const request = {
    documentId: opened.documentId,
    clientTransactionId: `tx-srv16-${randomUUID()}`,
    baseRevision: opened.currentRevision,
    segments: [base64(segment)],
    document: base64(content.document),
  };
  return { segment, request, answer: await post("/api/v1/evidence/commit", request, session) };
}
type Document = ReturnType<typeof written>;
type Start = Parameters<typeof written>[0];
const startOf = (opened: Opened) =>
  JSON.parse(Buffer.from(opened.document, "base64").toString()) as Start;

// SRV-33: a source and a citation of it, invented, in the second block (a
// paragraph). The segment stays in the edit-steps v1 format the server takes
// today: its steps write the text, and the citation and the source are in the
// snapshot the segment ends in (v2 steps are a later step, document v2 §5.4).
const SOURCE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE = {
  type: "book",
  id: SOURCE_ID,
  authors: [{ kind: "person", family: "Prezime", given: "Ime" }],
  year: 2020,
  title: "Izvor 1",
  place: "Zagreb",
  publisher: "Nakladnik",
};
function cited(content: Document): Document {
  const doc = JSON.parse(content.document) as {
    nodes: { children: Record<string, unknown>[] }[];
    sources: unknown[];
  };
  doc.nodes[1]!.children.push({ type: "citation", sourceId: SOURCE_ID, locator: "str. 12" });
  // A rerun continues a document that already has the source: ids are unique.
  if (!doc.sources.some((source) => (source as { id: string }).id === SOURCE_ID)) {
    doc.sources = [...doc.sources, SOURCE];
  }
  return { ...content, document: canonicalizeJcs(doc) };
}

/** Open, one commit of `make(start)`, a receipt that verifies, and a replay that ends in it. */
async function wholeFlow(session: string, make: (start: Start) => Document) {
  const opened = await open(session);
  expect(opened.status).toBe("opened");
  expect(sha256(Buffer.from(opened.document, "base64").toString("utf8"))).toBe(opened.documentHash);
  const content = make(startOf(opened));

  const { segment, request, answer } = await commitOver(
    opened,
    content,
    sha256(content.document),
    session,
  );
  expect(answer.status).toBe(200);
  expect(answer.body).toMatchObject({
    status: "committed",
    revision: opened.currentRevision + 1,
    receipt: { status: "signed" },
  });
  const signedReceipt = (
    answer.body.receipt as { signedReceipt: { payload: Record<string, unknown> } }
  ).signedReceipt;
  const verified = await verifySignedEvidenceReceiptV2(
    signedReceipt,
    {
      documentId: opened.documentId,
      clientTransactionId: request.clientTransactionId,
      revision: opened.currentRevision + 1,
      evidenceDomainId: domainId,
    },
    opened.receiptKeys,
  );
  expect(verified).toMatchObject({ ok: true });
  expect(signedReceipt.payload.segmentHash).toBe(sha256(segment));

  // The replay hands back the stored bytes; the chain they make ends in the
  // committed document, and open now serves exactly that document. One
  // commit is one segment, so this segment has index `currentRevision`. A
  // rerun over the same database reads only this segment, pinned to the
  // head it makes: earlier runs' payloads lived in their own process.
  const from = opened.currentRevision;
  const head = { segmentHash: sha256(segment), segmentCount: from + 1 };
  const page = await post(
    "/api/v1/evidence/replay",
    { documentId: opened.documentId, from, ...(from === 0 ? {} : { head }) },
    session,
  );
  expect(page.status).toBe(200);
  expect(page.text).toBe(canonicalizeJcs(page.body));
  expect(page.body).toMatchObject({ head, from, next: null, segments: [segment] });
  let hash = from === 0 ? sha256(String(page.body.startDocument)) : opened.documentHash;
  expect(hash).toBe(opened.documentHash);
  for (const bytes of page.body.segments as string[]) {
    const checked = await verifyCanonicalEvidencePayloadV2(new TextEncoder().encode(bytes));
    if (!checked.ok) throw new Error(`replayed segment refused: ${checked.reason}`);
    expect(checked.segment.initialDocumentHash).toBe(hash);
    hash = checked.segment.finalDocumentHash;
  }
  expect(hash).toBe(sha256(content.document));
  const reopened = await open(session);
  expect(reopened).toMatchObject({
    currentRevision: opened.currentRevision + 1,
    documentHash: hash,
    headSegmentHash: sha256(segment),
  });
  expect(Buffer.from(reopened.document, "base64").toString("utf8")).toBe(content.document);
  return { start: startOf(opened), content };
}

describe("SRV-16: the evidence of the seeded work, from open to replay", () => {
  it("open -> commit -> Ed25519 receipt -> replay ends in the JCS hash of the same document", async () => {
    const { start, content } = await wholeFlow(token, written);
    expect(start.schemaVersion).toBe(1);
    expect(JSON.parse(content.document)).toMatchObject({ schemaVersion: 1 });
  });

  it("SRV-33: the same flow over a document v2 with a source and a citation, on a v2 work", async () => {
    const { start, content } = await wholeFlow(tokenV2, (begin) => cited(written(begin)));
    expect(start.schemaVersion).toBe(2);
    expect(JSON.parse(content.document)).toMatchObject({ schemaVersion: 2, sources: [SOURCE] });
  });

  // Each work keeps the version of its revision 0 (document v2 §7 t. 4): the
  // database refuses the revision and writes nothing. The commit path answers
  // that as unavailable until the work's version reaches the commit context
  // (database step 2, Ductus#2028 c.7035293975), when this becomes a 422.
  it.each([
    [
      "a v1 document on the v2 work",
      () => tokenV2,
      // Only the new blocks: the v2 work's own may hold a citation, which v1 refuses.
      () => written({ schemaVersion: 1, nodes: [] }),
    ],
    [
      "a v2 document on the v1 work",
      () => token,
      (start: Start) => cited(written({ ...start, schemaVersion: 2, sources: [] } as Start)),
    ],
  ])("SRV-33: %s is refused and changes nothing", async (_, session, make) => {
    const opened = await open(session());
    const content = make(startOf(opened));
    const { answer } = await commitOver(opened, content, sha256(content.document), session());
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ status: "unavailable", stage: "repository" });
    expect(await open(session())).toMatchObject({
      currentRevision: opened.currentRevision,
      documentHash: opened.documentHash,
    });
  });

  it("B-8: a document with a field the schema does not know is refused and changes nothing", async () => {
    const opened = await open();
    const content = written(startOf(opened));
    const parsed = JSON.parse(content.document) as { nodes: Record<string, unknown>[] };
    parsed.nodes[0]!.boja = "crvena";
    const unknown = { ...content, document: canonicalizeJcs(parsed) };
    const { answer } = await commitOver(opened, unknown);
    // As the contract's vector invalid-unknown-field (evidence.commit.post).
    expect(answer.status).toBe(422);
    expect(answer.body).toEqual({ status: "invalid" });
    expect(await open()).toMatchObject({
      currentRevision: opened.currentRevision,
      documentHash: opened.documentHash,
    });
  });

  it("a segment whose final hash is broken by one character is refused and changes nothing", async () => {
    const opened = await open();
    const content = written(startOf(opened));
    // The segment says, consistently, that it ends in the broken hash.
    const { answer } = await commitOver(opened, content, broken(sha256(content.document)));
    // As the contract's vector document-mismatch: the snapshot is not the segment's end.
    expect(answer.status).toBe(422);
    expect(answer.body).toEqual({ status: "document_mismatch" });
    expect(await open()).toMatchObject({
      currentRevision: opened.currentRevision,
      documentHash: opened.documentHash,
    });
  });
});

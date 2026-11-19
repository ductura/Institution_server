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
// document's. The seed is idempotent, so a rerun continues the same work from
// its current head. Development signer only (NODE_ENV test); its seed is
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

const open = async () => (await post("/api/v1/evidence/open", { assignmentId })).body as Opened;

/** One commit of `content` over the work as `opened` left it, by a segment that ends in `claimed`. */
async function commitOver(opened: Opened, content: Document, claimed = sha256(content.document)) {
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
  return { segment, request, answer: await post("/api/v1/evidence/commit", request) };
}
type Document = ReturnType<typeof written>;
type Start = Parameters<typeof written>[0];
const startOf = (opened: Opened) =>
  JSON.parse(Buffer.from(opened.document, "base64").toString()) as Start;

describe("SRV-16: the evidence of the seeded work, from open to replay", () => {
  it("open -> commit -> Ed25519 receipt -> replay ends in the JCS hash of the same document", async () => {
    const opened = await open();
    expect(opened.status).toBe("opened");
    expect(sha256(Buffer.from(opened.document, "base64").toString("utf8"))).toBe(
      opened.documentHash,
    );
    const content = written(startOf(opened));

    const { segment, request, answer } = await commitOver(opened, content);
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
    const page = await post("/api/v1/evidence/replay", {
      documentId: opened.documentId,
      from,
      ...(from === 0 ? {} : { head }),
    });
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
    const reopened = await open();
    expect(reopened).toMatchObject({
      currentRevision: opened.currentRevision + 1,
      documentHash: hash,
      headSegmentHash: sha256(segment),
    });
    expect(Buffer.from(reopened.document, "base64").toString("utf8")).toBe(content.document);
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

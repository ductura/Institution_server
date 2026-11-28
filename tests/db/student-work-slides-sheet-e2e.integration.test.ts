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
  createWorkExportReader,
  createWorkOpener,
} from "../../server/database/index.ts";
import {
  applySheetSteps,
  applySlideSteps,
  canonicalizeJcs,
  parseSheetSteps,
  parseSlideSteps,
  SHEET_STEP_FORMAT_V1,
  sheetDigest,
  sheetRevisionZeroDocument,
  SLIDE_STEP_FORMAT_V1,
  SLIDES_REVISION_ZERO_SHA256,
  slidesRevisionZeroDocument,
  type EvidenceSegment,
  type JcsJsonValue,
} from "../../server/domain/index.ts";
import { sheetCellSha256 } from "../../server/domain/sheet/index.ts";
import { replaySheetSegments } from "../../server/evidence/sheet/index.ts";
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
  createSheetCsvRouteFor,
  createSheetXlsxRouteFor,
  createStudentSubmissionRoutesFor,
  createSubmissionRouteFor,
  createWorkExportSlidesRoute,
  type Running,
  startServer,
} from "../../server/http/index.ts";

// F4-V13-R04-SRV: the student half of wave 13 for a slides work and for a
// spreadsheet work, end to end through a real server over real PostgreSQL with
// RLS and a ductus_app login: open (app.open_student_work starts the kind of
// the assignment), commit two evidence segments of that kind's own step
// format, read the record back (replay), submit, read the receipt back and
// export the saved version. What the replay and the export give is compared
// with the document the commits carried. Every institution, person, token,
// text and key is random and synthetic; the login exists only while this file
// runs. Test only: nothing here changes the server.
const ADMIN_URL =
  process.env.DATABASE_URL ?? "postgres://ductus:ductus-local-only@127.0.0.1:54329/ductus";
const APP_LOGIN = "it_student_work_e2e_app";
const ORIGIN = "https://ductura.example.invalid";
const ROOT = join(import.meta.dirname, "../..");
const password = randomBytes(24).toString("hex");
const suffix = randomBytes(4).toString("hex");
const STUDENTS = ["ana", "bruno", "cvita"] as const;
type Student = (typeof STUDENTS)[number];
const id = {
  a: randomUUID(),
  adminA: randomUUID(),
  vesna: randomUUID(),
  k1: randomUUID(),
  zSlides: randomUUID(),
  zSheet: randomUUID(),
  domainA: randomUUID(),
};
const user = Object.fromEntries(STUDENTS.map((s) => [s, randomUUID()])) as Record<Student, string>;
const token = Object.fromEntries(
  STUDENTS.map((s) => [s, randomBytes(32).toString("base64url")]),
) as Record<Student, string>;
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// The seed lives outside the repository, as the signer demands.
const seedDir = mkdtempSync(join(tmpdir(), "f4v13r04-"));
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
) as { chain: { segments: { segment: GoldenSegment }[] } };

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
let app: pg.Pool;
let server: Running;

async function fixture(): Promise<void> {
  const q = (text: string, values: unknown[] = []) => admin.query(text, values);
  await q("BEGIN");
  await q("INSERT INTO identity.institution (id, slug) VALUES ($1, $2)", [
    id.a,
    `it-e2e-${suffix}`,
  ]);
  await q(
    `INSERT INTO institution.institution_settings
       (institution_id, display_name, enrollment_attempt_limit, enrollment_attempt_window)
     VALUES ($1, 'Izmišljeni fakultet (test)', 5, '15 minutes')`,
    [id.a],
  );
  const accounts: [string, string][] = [
    [id.adminA, "adminA"],
    [id.vesna, "vesna"],
    ...STUDENTS.map((s) => [user[s], s] as [string, string]),
  ];
  for (const [account, name] of accounts) {
    await q(
      `INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
       VALUES ($1, $2, 'https://issuer.example.invalid', $3, $4)`,
      [account, id.a, `sub-${name}-${suffix}`, `${name}-${suffix}@fak.invalid`],
    );
  }
  for (const s of STUDENTS) {
    await q(
      `INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
       VALUES (sha256(convert_to($1, 'UTF8')), $2, $3, now() + interval '1 hour')`,
      [token[s], user[s], id.a],
    );
  }
  await q("SELECT institution.appoint_institution_admin($1, $2)", [id.adminA, `Zahtjev ${suffix}`]);
  await q(
    `INSERT INTO institution.institution_role (institution_id, user_id, role, confirmed_by, confirmed_at)
     VALUES ($1, $2, 'teacher', $3, now())`,
    [id.a, id.vesna, id.adminA],
  );
  await q(
    `INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
     VALUES ($1, $2, 'Izmišljeni kolegij (test)', '2026/2027', 'partially_allowed', $3)`,
    [id.k1, id.a, id.vesna],
  );
  await q(
    `INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'teacher' UNION ALL SELECT $1::uuid, $2::uuid, unnest($4::uuid[]), 'student'`,
    [id.k1, id.a, id.vesna, STUDENTS.map((s) => user[s])],
  );
  for (const [assignment, kind] of [
    [id.zSlides, "slides"],
    [id.zSheet, "spreadsheet"],
  ] as const) {
    await q(
      `INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by, document_kind)
       VALUES ($1, $2, $3, 1, $4, $5)`,
      [assignment, id.k1, id.a, id.vesna, kind],
    );
    await q(
      `INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
         opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
       VALUES ($1, 1, 'Izmišljeni zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
         now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, $2)`,
      [assignment, id.vesna],
    );
    await q(
      `INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
       SELECT $1::uuid, 1, unnest($2::uuid[]), $3::uuid`,
      [assignment, STUDENTS.map((s) => user[s]), id.a],
    );
  }
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
      createSubmissionRouteFor(main, { signer, payloads }),
      ...createStudentSubmissionRoutesFor(main),
      createSheetXlsxRouteFor(main),
      createSheetCsvRouteFor(main),
      // No image in these decks, and no converter: only the .pptx is asked for.
      createWorkExportSlidesRoute(createWorkExportReader(withActor), async () => null, undefined),
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

type Answer = {
  status: number;
  bytes: Buffer;
  text: string;
  body: Record<string, unknown>;
  headers: Record<string, unknown>;
};
function call(
  method: "GET" | "POST",
  path: string,
  who: Student | null,
  body?: unknown,
): Promise<Answer> {
  const text = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server.port,
        method,
        path,
        headers: {
          origin: ORIGIN,
          "sec-fetch-site": "same-origin",
          ...(text === undefined
            ? {}
            : {
                "content-type": "application/json",
                "ductus-protocol": "1",
                "content-length": String(Buffer.byteLength(text)),
              }),
          ...(who === null ? {} : { cookie: `__Host-ductus_session=${token[who]}` }),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const bytes = Buffer.concat(chunks);
          const decoded = bytes.toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(decoded) as Record<string, unknown>;
          } catch {
            // An export is not JSON; the bytes are what is read then.
          }
          resolve({
            status: res.statusCode ?? 0,
            bytes,
            text: decoded,
            body: parsed,
            headers: res.headers,
          });
        });
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}
/** The problem of a refusal without its per-request id: what tells one refusal from another. */
const problemOf = (answer: Answer) => ({
  status: answer.status,
  error: answer.body.error,
  code: answer.body.code,
  messageKey: answer.body.messageKey,
});
const post = (path: string, body: unknown, who: Student) => call("POST", path, who, body);
const get = (path: string, who: Student | null) => call("GET", path, who);

/** What one student's write left behind: the bytes of each segment and of each saved document. */
type Written = {
  documentId: string;
  openedHash: string;
  opened: Record<string, unknown>;
  segments: string[];
  documents: string[];
  revisions: number[];
};

/**
 * Opens the student's work of the assignment and commits each group of events
 * (a list of step lists) as one segment, chained from revision 0. The document
 * after every event is the step reader's and applier's own, so the hashes are
 * those the server's replayer will find.
 */
async function write(
  who: Student,
  assignmentId: string,
  format: string,
  start: JcsJsonValue,
  apply: (document: JcsJsonValue, steps: unknown) => JcsJsonValue,
  segmentSteps: readonly (readonly (readonly unknown[])[])[],
  refused?: { status: number; body: unknown },
): Promise<Written> {
  const opened = await post("/api/v1/evidence/open", { assignmentId, start: true }, who);
  expect(opened.status, opened.text).toBe(200);
  const { documentId, documentHash, evidenceProfileId } = opened.body as {
    documentId: string;
    documentHash: string;
    evidenceProfileId: string;
  };
  let document = start;
  let documentText = canonicalizeJcs(document);
  expect(documentHash).toBe(sha256(documentText));
  const written: Written = {
    documentId,
    openedHash: documentHash,
    opened: opened.body,
    segments: [],
    documents: [],
    revisions: [],
  };
  const template = chain.segments[0]!.segment;
  let predecessor: string | null = null;
  let sequence = 0;
  let revision = 0;
  for (const [index, events] of segmentSteps.entries()) {
    const initial = sha256(documentText);
    const built = events.map((steps) => {
      sequence += 1;
      const before = sha256(documentText);
      document = apply(document, steps);
      documentText = canonicalizeJcs(document);
      return {
        sequence,
        source: "editor",
        steps,
        beforeDocumentHash: before,
        afterDocumentHash: sha256(documentText),
      };
    });
    const segment = canonicalizeJcs({
      ...template,
      documentId,
      sessionId: `sesija-${who}-${suffix}`,
      segmentId: `segment-${who}-${suffix}-${index + 1}`,
      sequenceFrom: built[0]!.sequence,
      sequenceTo: built.at(-1)!.sequence,
      initialDocumentHash: initial,
      finalDocumentHash: sha256(documentText),
      predecessorSegmentHash: predecessor,
      evidenceProfileId,
      events: built,
      captureContext: { editorModel: "prosemirror", transactionFormat: format },
    } as unknown as JcsJsonValue);
    const committed = await post(
      "/api/v1/evidence/commit",
      {
        documentId,
        clientTransactionId: `tx-${who}-${suffix}-${index + 1}`,
        baseRevision: revision,
        segments: [Buffer.from(segment, "utf8").toString("base64")],
        document: Buffer.from(documentText, "utf8").toString("base64"),
      },
      who,
    );
    if (refused !== undefined) {
      expect(committed.status, committed.text).toBe(refused.status);
      expect(committed.body).toEqual(refused.body);
      return written;
    }
    expect(committed.status, committed.text).toBe(200);
    expect(committed.body).toMatchObject({ status: "committed", receipt: { status: "signed" } });
    revision = committed.body.revision as number;
    expect(revision).toBeGreaterThan(written.revisions.at(-1) ?? 0);
    predecessor = sha256(segment);
    written.segments.push(segment);
    written.documents.push(documentText);
    written.revisions.push(revision);
  }
  return written;
}

/** Applies the steps of one event of a slides work, or fails the test. */
function applySlides(document: JcsJsonValue, steps: unknown): JcsJsonValue {
  const parsed = parseSlideSteps(steps);
  if (!parsed.ok) throw new Error(`slide steps: ${parsed.error}`);
  const applied = applySlideSteps(document as never, parsed.steps);
  if (!applied.ok) throw new Error(`slide steps refused: ${applied.error}`);
  return applied.doc as unknown as JcsJsonValue;
}

/** Applies the steps of one event of a spreadsheet work, or fails the test. */
function applySheet(document: JcsJsonValue, steps: unknown): JcsJsonValue {
  const parsed = parseSheetSteps(steps);
  if (!parsed.ok) throw new Error(`sheet steps: ${parsed.error}`);
  const applied = applySheetSteps(document as never, parsed.steps);
  if (!applied.ok) throw new Error(`sheet steps refused: ${applied.error}`);
  return applied.doc as unknown as JcsJsonValue;
}

// The slides work: a heading and a paragraph in the first segment; a second
// slide, a longer paragraph and speaker notes in the second.
const slide1 = "00000000-0000-4000-8000-000000000000";
const slide2 = randomUUID();
const headingId = randomUUID();
const paragraphId = randomUUID();
const heading = {
  type: "heading",
  id: headingId,
  slot: "title",
  text: "Izmisljeni naslov",
} as const;
const paragraph = {
  type: "paragraph",
  id: paragraphId,
  slot: "body",
  text: "Prvi odlomak",
} as const;
const SLIDES_STEPS = [
  [
    [{ type: "blockSet", slideId: slide1, index: 0, block: heading }],
    [{ type: "blockSet", slideId: slide1, index: 1, block: paragraph }],
  ],
  [
    [{ type: "slideAdd", slideId: slide2, layout: "title", index: 1 }],
    [
      {
        type: "textEdit",
        slideId: slide1,
        blockId: paragraphId,
        from: 12,
        to: 12,
        insert: " i drugi dio",
      },
      { type: "notesSet", slideId: slide1, notes: "Izmisljena biljeska." },
    ],
  ],
] as const;
const slidesFinal = {
  documentKind: "slides",
  schemaVersion: 1,
  slides: [
    {
      id: slide1,
      layout: "titleContent",
      blocks: [heading, { ...paragraph, text: "Prvi odlomak i drugi dio" }],
      notes: "Izmisljena biljeska.",
    },
    { id: slide2, layout: "title", blocks: [] },
  ],
};

// The spreadsheet work: two numbers in the first segment; a formula over them
// and a replaced number (the step carries the hash of what it replaces) in the
// second.
const sheet1 = "00000000-0000-4000-8000-000000000000";
const SHEET_STEPS = [
  [
    [{ type: "cellSet", sheetId: sheet1, ref: "A1", value: 2 }],
    [{ type: "cellSet", sheetId: sheet1, ref: "A2", value: 3 }],
  ],
  [
    [{ type: "cellSet", sheetId: sheet1, ref: "A3", formula: "=SUM(A1:A2)" }],
    [
      {
        type: "cellSet",
        sheetId: sheet1,
        ref: "A1",
        value: 4,
        replacedSha256: sheetCellSha256({ value: 2 }),
      },
    ],
  ],
] as const;
const sheetFinal = {
  schemaVersion: 1,
  kind: "spreadsheet",
  sheets: [
    {
      id: sheet1,
      name: "List1",
      rows: 100,
      columns: 10,
      cells: Object.fromEntries([
        ["A1", { value: 4 }],
        ["A2", { value: 3 }],
        ["A3", { value: null, formula: "=SUM(A1:A2)" }],
      ]),
    },
  ],
};

const receiptOf = (answer: Answer) =>
  (answer.body.receipt as { payload: Record<string, unknown> }).payload;

describe("the steps of the test are the ones the documents' own code applies", () => {
  it("builds the documents these tests expect", () => {
    let slides = slidesRevisionZeroDocument() as unknown as JcsJsonValue;
    for (const steps of SLIDES_STEPS.flat()) slides = applySlides(slides, steps);
    expect(canonicalizeJcs(slides)).toBe(canonicalizeJcs(slidesFinal as unknown as JcsJsonValue));
    let sheet = sheetRevisionZeroDocument() as unknown as JcsJsonValue;
    for (const steps of SHEET_STEPS.flat()) sheet = applySheet(sheet, steps);
    expect(canonicalizeJcs(sheet)).toBe(canonicalizeJcs(sheetFinal as unknown as JcsJsonValue));
  });
});

// SRV gap, documented and not fixed here (test only): the commit context reader
// (server/database/commit-context.ts, KINDS) knows only "text" and "spreadsheet",
// and its unit test says "a slides work, which this reader does not know yet".
// A slides work therefore opens, but its first commit is refused with 503
// unavailable at stage context; the commit, submit, replay and export steps of
// a slides work cannot be reached through the routes. The slides domain, the
// commit dispatch and the export route exist; only the context reader is
// missing the kind. When it learns it, this block becomes the full flow of the
// spreadsheet block below.
describe("a slides work today: opens, and the commit is refused at the context (F4-V13-R04-SRV)", () => {
  let work: Written;

  beforeAll(async () => {
    work = await write(
      "ana",
      id.zSlides,
      SLIDE_STEP_FORMAT_V1,
      slidesRevisionZeroDocument() as unknown as JcsJsonValue,
      applySlides,
      SLIDES_STEPS,
      { status: 503, body: { status: "unavailable", stage: "context" } },
    );
  });

  it("opens a work of kind slides from the slides revision 0", () => {
    expect(work.openedHash).toBe(SLIDES_REVISION_ZERO_SHA256);
    expect(work.opened).toMatchObject({ workKind: "slides", slidesSchemaVersion: 1 });
    expect(Buffer.from(work.opened.document as string, "base64").toString("utf8")).toBe(
      canonicalizeJcs(slidesRevisionZeroDocument() as unknown as JcsJsonValue),
    );
  });

  it("the refused commit leaves the work at revision 0", async () => {
    const again = await post(
      "/api/v1/evidence/open",
      { assignmentId: id.zSlides, start: true },
      "ana",
    );
    expect(again.status, again.text).toBe(200);
    expect(again.body).toMatchObject({
      documentId: work.documentId,
      workKind: "slides",
      documentHash: SLIDES_REVISION_ZERO_SHA256,
    });
  });

  it("the sheet exports are not made of a deck: the same 404 as a missing work", async () => {
    const missing = await get(`/api/v1/works/${randomUUID()}/export/xlsx`, "ana");
    expect(missing.status).toBe(404);
    for (const path of ["export/xlsx", "export/csv"]) {
      const answer = await get(`/api/v1/works/${work.documentId}/${path}`, "ana");
      expect(problemOf(answer)).toEqual(problemOf(missing));
    }
  });

  it("another student of the course gets the 404 of a missing work, for the export and the replay", async () => {
    const missing = await get(`/api/v1/works/${randomUUID()}/export-slides?format=pptx`, "cvita");
    expect(missing.status).toBe(404);
    const theirs = await get(`/api/v1/works/${work.documentId}/export-slides?format=pptx`, "cvita");
    expect(problemOf(theirs)).toEqual(problemOf(missing));
    const replay = await post(
      "/api/v1/evidence/replay",
      { documentId: work.documentId, from: 0 },
      "cvita",
    );
    expect(replay.status).toBe(404);
  });
});

describe("a spreadsheet work, from the first open to the export (F4-V13-R04-SRV)", () => {
  let work: Written;

  beforeAll(async () => {
    work = await write(
      "bruno",
      id.zSheet,
      SHEET_STEP_FORMAT_V1,
      sheetRevisionZeroDocument() as unknown as JcsJsonValue,
      applySheet,
      SHEET_STEPS,
    );
  });

  it("opens a work of kind spreadsheet from the spreadsheet revision 0", () => {
    const zero = canonicalizeJcs(sheetRevisionZeroDocument() as unknown as JcsJsonValue);
    expect(work.openedHash).toBe(sha256(zero));
    expect(work.opened).toMatchObject({ workKind: "spreadsheet", sheetSchemaVersion: 1 });
    expect(Buffer.from(work.opened.document as string, "base64").toString("utf8")).toBe(zero);
    expect(work.documents.at(-1)).toBe(canonicalizeJcs(sheetFinal as unknown as JcsJsonValue));
    expect(work.revisions).toHaveLength(2);
  });

  it("the replay gives the committed segments, and replaying them rebuilds the committed document", async () => {
    const page = await post(
      "/api/v1/evidence/replay",
      { documentId: work.documentId, from: 0 },
      "bruno",
    );
    expect(page.status, page.text).toBe(200);
    expect(page.body).toMatchObject({
      segmentCount: 2,
      head: { segmentHash: sha256(work.segments[1]!), segmentCount: 2 },
      next: null,
      segments: work.segments,
    });
    const start = JSON.parse(page.body.startDocument as string) as JcsJsonValue;
    const segments = (page.body.segments as string[]).map(
      (text) => JSON.parse(text) as EvidenceSegment,
    );
    const replayed = await replaySheetSegments(segments, start);
    expect(replayed).toEqual({
      ok: true,
      canonicalDocument: work.documents.at(-1),
      documentSha256: sha256(work.documents.at(-1)!),
    });
  });

  it("submits the last revision: a signed receipt of this work, then the same bytes again", async () => {
    const answer = await post(
      "/api/v1/submission",
      { documentId: work.documentId, revision: work.revisions.at(-1) },
      "bruno",
    );
    expect(answer.status, answer.text).toBe(200);
    expect(answer.body.status).toBe("submitted");
    expect(receiptOf(answer)).toMatchObject({
      receiptSchema: "ductus-submission-receipt-v2",
      documentId: work.documentId,
      revision: work.revisions.at(-1),
      assignmentId: id.zSheet,
      principalId: user.bruno,
      evidenceDomainId: id.domainA,
      evidenceRecord: "continuous",
      afterDeadline: false,
    });
    const again = await post(
      "/api/v1/submission",
      { documentId: work.documentId, revision: work.revisions.at(-1) },
      "bruno",
    );
    expect(again.status).toBe(200);
    expect(again.text).toBe(answer.text);
  });

  it("reads the submission back as the receipt the submission answered", async () => {
    const submitted = await post(
      "/api/v1/submission",
      { documentId: work.documentId, revision: work.revisions.at(-1) },
      "bruno",
    );
    const prefix = '{"status":"submitted","receipt":';
    expect(submitted.text.startsWith(prefix)).toBe(true);
    const receiptText = submitted.text.slice(prefix.length, -1);
    const bound = await get(`/api/v1/student/assignments/${id.zSheet}/submission`, "bruno");
    expect(bound.status, bound.text).toBe(200);
    expect(bound.text).toBe(`{"state":"potvrdeno","receipt":${receiptText}}`);
  });

  it("exports the .xlsx with the formula computed again over the committed cells", async () => {
    const exported = await get(`/api/v1/works/${work.documentId}/export/xlsx`, "bruno");
    expect(exported.status, exported.text).toBe(200);
    expect(exported.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(exported.headers["x-export-sheet-sha256"]).toBe(sheetDigest(sheetFinal as never));
    expect(exported.bytes.subarray(0, 4).toString("hex")).toBe("504b0304");
    // A1 was replaced by 4, so the sum is 4 + 3.
    expect(exported.bytes.toString("latin1")).toContain("<f>SUM(A1:A2)</f><v>7</v>");
  });

  it("exports the CSV of the first sheet with the same computed values", async () => {
    const exported = await get(`/api/v1/works/${work.documentId}/export/csv`, "bruno");
    expect(exported.status, exported.text).toBe(200);
    expect(exported.headers["content-type"]).toBe("text/csv; charset=utf-8");
    const lines = exported.text
      .replace(/^﻿/u, "")
      .split("\r\n")
      .filter((line) => line !== "");
    expect(lines).toEqual(["4", "3", "7"]);
  });

  it("the deck export is not made of a sheet: the same 404 as a missing work", async () => {
    const missing = await get(`/api/v1/works/${randomUUID()}/export-slides?format=pptx`, "bruno");
    expect(missing.status).toBe(404);
    const answer = await get(`/api/v1/works/${work.documentId}/export-slides?format=pptx`, "bruno");
    expect(answer.status).toBe(404);
    expect(problemOf(answer)).toEqual(problemOf(missing));
  });

  it("another student of the course gets the 404 of a missing work, for the export and the replay", async () => {
    const missing = await get(`/api/v1/works/${randomUUID()}/export/xlsx`, "cvita");
    expect(missing.status).toBe(404);
    const theirs = await get(`/api/v1/works/${work.documentId}/export/xlsx`, "cvita");
    expect(theirs.status).toBe(404);
    expect(problemOf(theirs)).toEqual(problemOf(missing));
    const replay = await post(
      "/api/v1/evidence/replay",
      { documentId: work.documentId, from: 0 },
      "cvita",
    );
    expect(replay.status).toBe(404);
  });
});

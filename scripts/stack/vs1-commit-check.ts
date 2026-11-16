// DAN-817 C, plan of attack ductura/server#129 (E1, P6): on a running VS-1
// stack, a real evidence/commit is 200 with a signed receipt that verifies
// under the keys open hands out, and the object lands in the stack's local
// S3; the same build under NODE_ENV=production answers 503 and stores
// nothing. Local stack and CI only (`pnpm stack:vs1 up` first). Every
// person, course and text is invented; the session token is random.
//   node scripts/stack/vs1-commit-check.ts
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SERVER_NODE_FLAGS } from "../build/index.ts";
import {
  canonicalizeJcs,
  type EvidenceDomainKey,
  verifySignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";
import { INSTITUTION_SLUG, storageDomains } from "./evidence.ts";
import { readState, serverReady, startDetached, stopProcess } from "./index.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url)).replace(/\/$/u, "");
const SERVER = join(ROOT, "dist", "server.js");
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

type Answer = { status: number; body: Record<string, unknown> };

/** One POST as the browser of a signed-in student sends it. */
export function post(port: number, path: string, body: unknown, token: string): Promise<Answer> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path,
        headers: {
          origin: `http://127.0.0.1:${port}`,
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
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as Answer["body"] });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: {} });
          }
        });
      },
    );
    req.on("error", reject);
    req.end(text);
  });
}

/** Objects in the local S3, the bucket identity label excepted. */
export function storedObjects(s3Root: string): string[] {
  return readdirSync(s3Root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== "ductus-storage-identity.json")
    .map((entry) => join(entry.parentPath, entry.name));
}

/**
 * Invented student, teacher, course and assignment of demo-fakultet, with a
 * session for the student; psql as the cluster's `ductus` over the stack's
 * own socket, every value a psql variable.
 */
function fixture(
  socket: string,
  port: number,
  token: string,
): { assignmentId: string; secondId: string } {
  const ids = {
    student: randomUUID(),
    teacher: randomUUID(),
    course: randomUUID(),
    assignment: randomUUID(),
    second: randomUUID(),
  };
  const tag = randomBytes(4).toString("hex");
  const sql = `\\set ON_ERROR_STOP on
BEGIN;
SELECT id AS inst FROM identity.institution WHERE slug = :'slug' \\gset
INSERT INTO identity.user_account (id, institution_id, oidc_issuer, oidc_subject, hr_edu_person_unique_id)
VALUES (:'student', :'inst', 'https://issuer.test', 'sub-student-' || :'tag', 'student-' || :'tag' || '@fak.invalid'),
       (:'teacher', :'inst', 'https://issuer.test', 'sub-teacher-' || :'tag', 'teacher-' || :'tag' || '@fak.invalid');
INSERT INTO identity.session (token_hash, user_id, institution_id, expires_at)
VALUES (sha256(convert_to(:'token', 'UTF8')), :'student', :'inst', now() + interval '1 hour');
INSERT INTO institution.course (id, institution_id, name, academic_year, ai_policy, created_by)
VALUES (:'course', :'inst', 'Kolegij (test)', '2026/2027', 'partially_allowed', :'teacher');
INSERT INTO institution.course_member (course_id, institution_id, user_id, role)
VALUES (:'course', :'inst', :'teacher', 'teacher'), (:'course', :'inst', :'student', 'student');
INSERT INTO institution.assignment (id, course_id, institution_id, current_version, created_by)
VALUES (:'assignment', :'course', :'inst', 1, :'teacher'), (:'second', :'course', :'inst', 1, :'teacher');
INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
  opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
SELECT a, 1, 'Zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
  now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, :'teacher'
  FROM unnest(ARRAY[:'assignment', :'second']::uuid[]) AS a;
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
SELECT a, 1, :'student', :'inst' FROM unnest(ARRAY[:'assignment', :'second']::uuid[]) AS a;
COMMIT;
`;
  const vars = { slug: INSTITUTION_SLUG, tag, token, ...ids };
  execFileSync(
    "psql",
    [
      "-h",
      socket,
      "-p",
      String(port),
      "-U",
      "ductus",
      "-d",
      "ductus",
      "-X",
      "-q",
      ...Object.entries(vars).flatMap(([name, value]) => ["-v", `${name}=${value}`]),
    ],
    { input: sql, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "ignore", "inherit"] },
  );
  return { assignmentId: ids.assignment, secondId: ids.second };
}

type GoldenSegment = Record<string, unknown> & { events: Record<string, unknown>[] };

/** The commit request of one segment, from the invented golden segment. */
function commitRequest(opened: Record<string, unknown>, transaction: string) {
  const { chain } = JSON.parse(
    readFileSync(join(ROOT, "server/domain/forensics/golden-vectors/evidence-v2.json"), "latin1"),
  ) as {
    chain: { segments: { segment: GoldenSegment }[]; documentStates: { value: unknown }[] };
  };
  const template = chain.segments[0]!.segment;
  const documentHash = opened.documentHash as string;
  const document = canonicalizeJcs(chain.documentStates[1]!.value);
  const segment = canonicalizeJcs({
    ...template,
    documentId: opened.documentId,
    sessionId: `sesija-${transaction}`,
    segmentId: `segment-${transaction}`,
    sequenceFrom: 1,
    sequenceTo: 1,
    initialDocumentHash: documentHash,
    finalDocumentHash: sha256(document),
    predecessorSegmentHash: null,
    evidenceProfileId: opened.evidenceProfileId,
    events: [
      {
        ...template.events[0],
        sequence: 1,
        beforeDocumentHash: documentHash,
        afterDocumentHash: sha256(document),
      },
    ],
  });
  return {
    documentId: opened.documentId,
    clientTransactionId: transaction,
    baseRevision: 0,
    segments: [Buffer.from(segment, "utf8").toString("base64")],
    document: Buffer.from(document, "utf8").toString("base64"),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

/** E1 and P6 against the stack in `stackDir`; throws on the first broken promise. */
export async function check(stackDir: string): Promise<void> {
  const state = readState(join(stackDir, "state.json"));
  if (state === null || state === "unreadable") fail("the stack is not up");
  const { ports } = state;
  const s3Root = join(stackDir, "s3");
  const token = randomBytes(32).toString("base64url");
  const { assignmentId, secondId } = fixture(stackDir, ports.postgres, token);

  // E1: open, commit, a signed receipt under open's keys, one new object.
  const opened = await post(
    ports.server,
    "/api/v1/evidence/open",
    { assignmentId, start: true },
    token,
  );
  if (opened.status !== 200) fail(`open answered ${opened.status}`);
  const before = storedObjects(s3Root).length;
  const req = commitRequest(opened.body, `tx-${randomBytes(4).toString("hex")}`);
  const committed = await post(ports.server, "/api/v1/evidence/commit", req, token);
  if (committed.status !== 200 || committed.body.status !== "committed") {
    fail(`commit answered ${committed.status} ${JSON.stringify(committed.body)}`);
  }
  const receipt = committed.body.receipt as { status?: string; signedReceipt?: unknown };
  if (receipt?.status !== "signed") fail("the receipt is not signed");
  const keys = opened.body.receiptKeys as EvidenceDomainKey[];
  const domain = keys[0] as { evidenceDomainId?: string } | undefined;
  const verified = await verifySignedEvidenceReceiptV2(
    receipt.signedReceipt,
    {
      documentId: req.documentId as string,
      clientTransactionId: req.clientTransactionId,
      revision: 1,
      evidenceDomainId: domain?.evidenceDomainId ?? "",
    },
    keys,
  );
  if (!verified.ok) fail("the receipt does not verify under open's receipt keys");
  if (storedObjects(s3Root).length !== before + 1) fail("no new object in the local S3");

  // P6: the same build and variables under NODE_ENV=production answer 503 and store nothing.
  const port = ports.server + 50;
  const institutionId = String(
    execFileSync(
      "psql",
      [
        "-h",
        stackDir,
        "-p",
        String(ports.postgres),
        "-U",
        "ductus",
        "-d",
        "ductus",
        "-X",
        "-tA",
        "-c",
        `SELECT id FROM identity.institution WHERE slug = '${INSTITUTION_SLUG}'`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } },
    ),
  ).trim();
  const argv = [...SERVER_NODE_FLAGS, SERVER, "--vs1-commit-check"];
  const pid = await startDetached(process.execPath, argv, {
    cwd: ROOT,
    log: join(stackDir, "commit-check-production.log"),
    env: {
      PATH: process.env.PATH ?? "",
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      PORT: String(port),
      APP_ORIGIN: `http://127.0.0.1:${port}`,
      APP_DATABASE_URL: `postgres://ductus_app_local:ductus-app-local-only@127.0.0.1:${ports.postgres}/ductus`,
      EVIDENCE_STORAGE_DOMAINS: storageDomains(institutionId, ports.s3),
      EVIDENCE_S3_VS1_KEY_ID: "izmisljeni",
      EVIDENCE_S3_VS1_SECRET: randomBytes(16).toString("hex"),
      DUCTUS_DEV_SIGNING_KEY_FILE: join(stackDir, "signing-seed"),
    },
  });
  try {
    if (!(await serverReady(`http://127.0.0.1:${port}/api/v1/health`, pid, port, 30_000))) {
      fail("the production server did not start");
    }
    // A document of its own, opened on the stack's server, so the request reaches storage.
    const fresh = await post(
      ports.server,
      "/api/v1/evidence/open",
      { assignmentId: secondId, start: true },
      token,
    );
    if (fresh.status !== 200) fail(`open of the second assignment answered ${fresh.status}`);
    const second = commitRequest(fresh.body, `tx-${randomBytes(4).toString("hex")}`);
    const refused = await post(port, "/api/v1/evidence/commit", second, token);
    if (refused.status !== 503) fail(`production commit answered ${refused.status}, not 503`);
    if (refused.body.status !== "unavailable") fail("production commit is not unavailable");
    if (storedObjects(s3Root).length !== before + 1) fail("production stored an object");
  } finally {
    await stopProcess(pid, [process.execPath, ...argv].join(" "), 10_000);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.env.VS1_STACK_DIR ?? join(ROOT, ".stack", "vs1");
  check(dir).then(
    () => console.log("VS-1 evidence/commit: 200 with a verified receipt; production: 503"),
    (error: unknown) => {
      console.error(
        `VS-1 evidence/commit check: ${error instanceof Error ? error.message : "failed"}`,
      );
      process.exitCode = 1;
    },
  );
}

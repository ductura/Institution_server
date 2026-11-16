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
import { INSTITUTION_SLUG } from "./evidence.ts";
import {
  commandLine,
  readState,
  serverReady,
  type StackState,
  startDetached,
  stopProcess,
} from "./index.ts";

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
): { assignmentId: string; second: string; control: string } {
  const ids = {
    student: randomUUID(),
    teacher: randomUUID(),
    course: randomUUID(),
    assignment: randomUUID(),
    second: randomUUID(),
    control: randomUUID(),
  };
  const tag = randomBytes(4).toString("hex");
  // Values reach psql through stdin, never argv: the session token is a live secret.
  const vars = { slug: INSTITUTION_SLUG, tag, token, ...ids };
  const sets = Object.entries(vars)
    .map(([name, value]) => `\\set ${name} '${value}'`)
    .join("\n");
  const sql = `${sets}
\\set ON_ERROR_STOP on
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
SELECT a, :'course', :'inst', 1, :'teacher'
  FROM unnest(ARRAY[:'assignment', :'second', :'control']::uuid[]) AS a;
INSERT INTO institution.assignment_version (assignment_id, version_no, title, instructions, work_type,
  opens_at, due_at, ai_policy, ai_purposes, evidence_profile, import_allowed, created_by)
SELECT a, 1, 'Zadatak (test)', 'Upute za izmišljeni zadatak.', 'essay', now(),
  now() + interval '30 days', 'partially_allowed', '{proofreading}', 'basic', true, :'teacher'
  FROM unnest(ARRAY[:'assignment', :'second', :'control']::uuid[]) AS a;
INSERT INTO institution.notice_acknowledgment (assignment_id, version_no, student_id, institution_id)
SELECT a, 1, :'student', :'inst' FROM unnest(ARRAY[:'assignment', :'second', :'control']::uuid[]) AS a;
COMMIT;
`;
  execFileSync(
    "psql",
    ["-h", socket, "-p", String(port), "-U", "ductus", "-d", "ductus", "-X", "-q"],
    { input: sql, env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "ignore", "inherit"] },
  );
  return { assignmentId: ids.assignment, second: ids.second, control: ids.control };
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
  const ids = fixture(stackDir, ports.postgres, token);
  const { assignmentId } = ids;

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

  // P6: the very variables the stack gave its server, S3 key included, under
  // NODE_ENV=production answer 503 storage and store nothing. A control run of
  // the same process under development must commit (200), so the 503 cannot
  // come from a wrong key, a wrong database or a server that never started.
  const env = stackServerEnv(state);
  const control = await commitThrough(env, "development", ports, stackDir, token, ids.control);
  if (control.status !== 200) fail(`the control under development answered ${control.status}`);
  if (storedObjects(s3Root).length !== before + 2) fail("the control stored no object");
  const refused = await commitThrough(env, "production", ports, stackDir, token, ids.second);
  if (refused.status !== 503 || refused.body.stage !== "storage") {
    fail(
      `production commit answered ${refused.status} ${JSON.stringify(refused.body)}, not 503 storage`,
    );
  }
  if (storedObjects(s3Root).length !== before + 2) fail("production stored an object");
}

/**
 * The environment of the stack's running server, read from /proc of that very
 * pid once its command line is the recorded one: the same S3 key and seed,
 * never written anywhere by the stack.
 */
export function stackServerEnv(state: StackState): Record<string, string> {
  const entry = state.processes.server;
  if (entry === undefined || commandLine(entry.pid) !== entry.marker) {
    fail("the stack's server is not the recorded process");
  }
  const env: Record<string, string> = {};
  for (const pair of readFileSync(`/proc/${entry.pid}/environ`, "utf8").split("\0")) {
    const at = pair.indexOf("=");
    if (at > 0) env[pair.slice(0, at)] = pair.slice(at + 1);
  }
  return env;
}

/** Opens `assignmentId` on the stack and commits it through a second server under `nodeEnv`. */
async function commitThrough(
  env: Record<string, string>,
  nodeEnv: "development" | "production",
  ports: StackState["ports"],
  stackDir: string,
  token: string,
  assignmentId: string,
): Promise<Answer> {
  const port = ports.server + 50;
  const argv = [...SERVER_NODE_FLAGS, SERVER, "--vs1-commit-check"];
  const pid = await startDetached(process.execPath, argv, {
    cwd: ROOT,
    log: join(stackDir, `commit-check-${nodeEnv}.log`),
    env: {
      ...env,
      NODE_ENV: nodeEnv,
      PORT: String(port),
      APP_ORIGIN: `http://127.0.0.1:${port}`,
    },
  });
  try {
    if (!(await serverReady(`http://127.0.0.1:${port}/api/v1/health`, pid, port, 30_000))) {
      fail(`the ${nodeEnv} server did not start`);
    }
    // A document of its own, opened on the stack's server, so the request reaches storage.
    const fresh = await post(
      ports.server,
      "/api/v1/evidence/open",
      { assignmentId, start: true },
      token,
    );
    if (fresh.status !== 200) fail(`open answered ${fresh.status}`);
    const req = commitRequest(fresh.body, `tx-${randomBytes(4).toString("hex")}`);
    return await post(port, "/api/v1/evidence/commit", req, token);
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

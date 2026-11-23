// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
// OD-15): POST /api/v1/submission on a real server over the real database,
// with the real declaration gate (declaration.submission_gate) in front of a
// port that writes the request through app.request_submission. The
// reconstruction and the signed receipt of submitWork are not under test here
// (submission.ts, evidence tests); the port answers the contract's receipt
// vector once the request is written. Only the fixtures of db/main/tests
// (invented people, documents and texts) are used.
import { readFileSync } from "node:fs";
import { connect } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../test-support/database/index.ts";
import {
  type ActorReader,
  createSubmissionDeclarationGate,
  type WithActor,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import {
  createSubmissionRoute,
  gatedSubmit,
  type SubmissionMajor,
  type SubmitWork,
} from "./submission.ts";

const FIXTURES = new URL("../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);
const SUBMITTED = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/submission.submit.post.json", import.meta.url),
      "utf8",
    ),
  ) as {
    vectors: {
      name: string;
      request: { headers: Record<string, string> };
      response: { body: { receipt: unknown } };
    }[];
  }
).vectors.find((v) => v.name === "submitted")!;

const ORIGIN = "https://ductura.example.invalid";
const ANA = "D".repeat(43);
const FORM =
  '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';

let db: TestDatabase;
let server: Running | undefined;

beforeEach(async () => {
  db = await createTestDatabase("main", { authority: true });
  await db.exec(institution);
  await db.exec(evidence);
  const committed = await db.query<{ outcome: string }>(`SELECT pg_temp.call('ana', 'pkg-a',
    'req-declaration-http', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64), repeat('b', 64)) AS outcome`);
  expect(committed.rows[0]?.outcome).toBe("reserved");
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  await db.close();
});

// Fixture writes and reads share the rollback-only test transaction.
const withActor: WithActor = async (token, run) => {
  await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
  await db.exec("SET LOCAL ROLE ductus_app");
  try {
    return await run({
      async query<Row>(text: string, values?: readonly unknown[]) {
        const { rows } = await db.query<Row>(text, [...(values ?? [])]);
        return { rows, rowCount: rows.length };
      },
    });
  } finally {
    await db.exec("RESET ROLE");
  }
};

// The click as submitWork makes it; a refused or failed request is 503 request.
const requestPort: SubmitWork = async (token, input) => {
  try {
    const outcome = await withActor(token, async (tx) => {
      const { rows } = await tx.query<{ outcome: string }>(
        "SELECT outcome FROM app.request_submission($1, $2)",
        [input.documentId, input.revision],
      );
      return rows[0]?.outcome;
    });
    if (outcome === "requested")
      return { status: "submitted", receipt: SUBMITTED.response.body.receipt };
    return { status: "unavailable", stage: "request", code: String(outcome) };
  } catch {
    return { status: "unavailable", stage: "request", code: "request_failed" };
  }
};

async function start(major: SubmissionMajor = 2) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [
      createSubmissionRoute({
        submit: gatedSubmit(createSubmissionDeclarationGate(withActor), requestPort),
        actors: {} as ActorReader,
        recordActivity: async () => undefined,
        major,
      }),
    ],
  });
}

function post(
  revision: number,
  major: SubmissionMajor = 2,
): Promise<{ status: number; body: unknown }> {
  const headers = { ...SUBMITTED.request.headers, cookie: `__Host-ductus_session=${ANA}` };
  const body = JSON.stringify({ documentId: "doc-a", revision });
  const head = [
    `POST ${major === 2 ? "/api/v1/submission/v2" : "/api/v1/submission"} HTTP/1.1`,
    "host: 127.0.0.1",
    ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    `content-length: ${Buffer.byteLength(body)}`,
  ].join("\r\n");
  return new Promise((resolve, reject) => {
    const socket = connect(server!.port, "127.0.0.1");
    let text = "";
    socket.write(`${head}\r\n\r\n${body}`);
    socket.on("data", (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const [top = "", ...rest] = text.split("\r\n\r\n");
      const length = Number(/content-length: (\d+)/iu.exec(top)?.[1] ?? -1);
      const payload = rest.join("\r\n\r\n");
      if (length >= 0 && Buffer.byteLength(payload) >= length) {
        socket.destroy();
        resolve({ status: Number(top.split(" ")[1]), body: JSON.parse(payload) });
      }
    });
    socket.on("error", reject);
  });
}

async function ask(actor: string, sql: string): Promise<string | null> {
  const { rows } = await db.query<{ answer: string | null }>(
    "SELECT pg_temp.ask($1, $2) AS answer",
    [actor, sql],
  );
  return rows[0]?.answer ?? null;
}
const requireDeclaration = (value: boolean) =>
  ask("vesna", `SELECT required::text FROM institution.set_declaration_required({z1}, ${value})`);
async function confirm(revision: number): Promise<string | null> {
  const { rows } = await db.query<{ sha: string }>(
    "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS sha",
    [FORM],
  );
  const body = {
    baseVersion: 0,
    revision,
    confirm: true,
    form: { formId: "test-izjava", formVersion: 1, formSha256: rows[0]!.sha },
    ownWork: { confirmed: true },
    humanHelp: { received: false, entries: [] },
    ai: { use: "not_used", attachments: [], declaredTools: [], externalAttachmentIds: [] },
  };
  const saved = await db.query<{ answer: string }>(
    "SELECT pg_temp.ask('ana', format('SELECT declaration.save_statement({z1}, %L::jsonb, %L)', $1::text, $2::text)) AS answer",
    [JSON.stringify(body), FORM],
  );
  return (
    (JSON.parse(saved.rows[0]!.answer) as { statement?: { state?: string } }).statement?.state ??
    null
  );
}
async function requests(): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM evidence.submission_request WHERE document_id = 'doc-a'",
  );
  return Number(rows[0]?.n);
}
// The second major (submission.submit-second.post) names the refusal; the first keeps its 503.
const REFUSED = { status: 409, body: { status: "declaration_required" } };
const REFUSED_FIRST = { status: 503, body: { status: "unavailable", stage: "request" } };

describe("a submission while the assignment requires a declaration", () => {
  it("(1) without a confirmed declaration is refused and nothing is written", async () => {
    expect(await requireDeclaration(true)).toBe("true");
    await start();
    expect(await post(1)).toEqual(REFUSED);
    expect(await requests()).toBe(0);
  });

  it("(1) on the first major the same refusal is its 503 request, and nothing is written", async () => {
    expect(await requireDeclaration(true)).toBe("true");
    await start(1);
    expect(await post(1, 1)).toEqual(REFUSED_FIRST);
    expect(await requests()).toBe(0);
  });

  it("(2) with a declaration confirmed for another revision is refused", async () => {
    expect(await requireDeclaration(true)).toBe("true");
    expect(await confirm(1)).toBe("confirmed");
    const second = await db.query<{ outcome: string }>(`SELECT pg_temp.call('ana', 'pkg-a',
      'req-declaration-http-2', pg_temp.descriptor(p_segment=>'segment-a-2', p_sequence_from=>2,
        p_sequence_to=>2, p_hash=>repeat('c',64), p_predecessor=>repeat('b',64)),
      1, repeat('d',64), repeat('e',64), repeat('c',64)) AS outcome`);
    expect(second.rows[0]?.outcome).toBe("reserved");
    await start();
    expect(await post(2)).toEqual(REFUSED);
    expect(await requests()).toBe(0);
  });

  it("(3) with a declaration confirmed for the submitted revision goes through and pins it", async () => {
    expect(await requireDeclaration(true)).toBe("true");
    expect(await confirm(1)).toBe("confirmed");
    await start();
    expect(await post(1)).toEqual({
      status: 200,
      body: { status: "submitted", receipt: SUBMITTED.response.body.receipt },
    });
    const pinned = await db.query<{
      pinned: boolean;
    }>(`SELECT declaration_version_id IS NOT NULL AS pinned
      FROM evidence.submission_request WHERE document_id = 'doc-a'`);
    expect(pinned.rows).toEqual([{ pinned: true }]);
  });

  it("(4) is as today while the switch is off: no declaration needed", async () => {
    await start();
    expect((await post(1)).status).toBe(200);
    expect(await requests()).toBe(1);
  });

  it("the student reads the switch from student.declaration.get's statement", async () => {
    const read = () =>
      ask("ana", "SELECT declaration.read_statement({z1}) #>> '{statement,declarationRequired}'");
    expect(await read()).toBe("false");
    await requireDeclaration(true);
    expect(await read()).toBe("true");
  });
});

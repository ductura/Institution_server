// SRV-IZJAVA-ODGOVOR-NULL (INT-32): GET
// /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration
// on a real server over the real database, for a declaration bound without an
// answer while the assignment asks a question. The course teacher and the
// mentor read 200 with questionAnswer null; before the fix the database built
// an object of nulls and the HTTP edge answered 503. Only the fixtures of
// db/main/tests (invented people, documents and texts) are used:
// institution.inc A Vesna (teacher of K1, z1), B Marko (mentor of zm1), D Ana.
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../../test-support/database/index.ts";
import { createTeacherDeclarationReader, type WithActor } from "../../database/index.ts";

import { createDatabases } from "../databases.ts";
import { createLayers } from "../pipeline.ts";
import { type Running, startServer } from "../start.ts";
import { createTeacherDeclarationRoute } from "./index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const fixture = (name: string) =>
  readFileSync(new URL(name, FIXTURES), "utf8").replace(/^\\ir .*\r?\n/gmu, "");
const ORIGIN = "https://ductura.example.invalid";
const VESNA = "A".repeat(43);
const MARKO = "B".repeat(43);
const FORM =
  '{"formId":"test-izjava","formSchema":"ductura-declaration-form-v1","formVersion":1,"text":"Izmišljeni obrazac."}';

let db: TestDatabase;
let server: Running | undefined;

beforeEach(async () => {
  db = await createTestDatabase("main", { authority: true });
  await db.exec(fixture("institution.inc"));
  await db.exec(fixture("evidence-acceptance.inc"));
  // As db/main/tests 249: mentorship.inc writes an assignment before its first version.
  await db.exec("SET CONSTRAINTS institution.assignment_current_version_institution_fkey DEFERRED");
  await db.exec(fixture("mentorship.inc"));
  await db.exec(
    "SET CONSTRAINTS institution.assignment_current_version_institution_fkey IMMEDIATE",
  );
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

async function ask(actor: string, sql: string): Promise<string | null> {
  const { rows } = await db.query<{ answer: string | null }>(
    "SELECT pg_temp.ask($1, $2) AS answer",
    [actor, sql],
  );
  return rows[0]?.answer ?? null;
}
async function id(name: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>("SELECT pg_temp.id($1)::text AS id", [name]);
  return rows[0]!.id;
}

/** Ana confirms a declaration without an answer, then requests and records revision 1 of `document`. */
async function bindWithoutAnswer(assignment: string, document: string): Promise<void> {
  const { rows } = await db.query<{ sha: string }>(
    "SELECT encode(sha256(convert_to($1, 'UTF8')), 'hex') AS sha",
    [FORM],
  );
  const body = {
    baseVersion: 0,
    revision: 1,
    confirm: true,
    form: { formId: "test-izjava", formVersion: 1, formSha256: rows[0]!.sha },
    ownWork: { confirmed: true },
    humanHelp: { received: false, entries: [] },
    ai: { use: "not_used", attachments: [], declaredTools: [], externalAttachmentIds: [] },
  };
  const saved = await ask(
    "ana",
    `SELECT declaration.save_statement('${await id(assignment)}', '${JSON.stringify(body)}'::jsonb, '${FORM}')`,
  );
  expect(JSON.parse(saved!).statement.state).toBe("confirmed");
  expect(await ask("ana", `SELECT outcome FROM app.request_submission('${document}', 1)`)).toBe(
    "requested",
  );
  const { rows: request } = await db.query<{ id: string; hash: string }>(
    "SELECT id::text, content_hash AS hash FROM evidence.submission_request WHERE document_id = $1",
    [document],
  );
  expect(
    await ask(
      "ana",
      `SELECT outcome FROM app.record_submission('${request[0]!.id}', '${request[0]!.hash}')`,
    ),
  ).toBe("recorded");
}

async function read(token: string, assignment: string) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createTeacherDeclarationRoute(createTeacherDeclarationReader(withActor))],
  });
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/v1/teacher/assignments/${await id(assignment)}/students/${await id("ana")}/declaration`,
    { headers: { cookie: `__Host-ductus_session=${token}`, "sec-fetch-site": "same-origin" } },
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

it("the course teacher reads a declaration bound without an answer: 200, questionAnswer null", async () => {
  expect(
    await ask(
      "vesna",
      `SELECT question_text FROM institution.set_declaration_question('${await id("z1")}', 'Koji ti je izvor najviše pomogao?')`,
    ),
  ).toBe("Koji ti je izvor najviše pomogao?");
  const committed = await db.query<{ outcome: string }>(`SELECT pg_temp.call('ana', 'pkg-a',
    'req-answer-null', pg_temp.descriptor(), 0, repeat('a', 64), repeat('d', 64), repeat('b', 64)) AS outcome`);
  expect(committed.rows[0]?.outcome).toBe("reserved");
  await bindWithoutAnswer("z1", "doc-a");

  const { status, body } = await read(VESNA, "z1");
  expect(status).toBe(200);
  expect(body.state).toBe("bound");
  expect(body.question).toMatchObject({ text: "Koji ti je izvor najviše pomogao?" });
  expect(body.questionAnswer).toBeNull();
});

it("the mentor reads a declaration bound without an answer: 200, questionAnswer null", async () => {
  expect(
    await ask(
      "marko",
      `SELECT question_text FROM institution.set_declaration_question('${await id("zm1")}', 'Mentorsko pitanje?')`,
    ),
  ).toBe("Mentorsko pitanje?");
  expect(await ask("ana", `SELECT outcome FROM app.open_student_work('${await id("zm1")}')`)).toBe(
    "opened",
  );
  const { rows } = await db.query<{ doc: string; pkg: string }>(
    `SELECT d.id AS doc, k.id AS pkg FROM evidence.document d
       JOIN evidence.project p ON p.id = d.project_id
       JOIN evidence.package k ON k.document_id = d.id
      WHERE p.principal_id = pg_temp.id('ana') AND p.assignment_id = pg_temp.id('zm1')`,
  );
  const { doc, pkg } = rows[0]!;
  const committed = await db.query<{ outcome: string }>(
    `SELECT pg_temp.call('ana', $1, 'req-answer-null-m',
       pg_temp.descriptor(p_package => $1, p_document => $2, p_segment => 'segment-m-1'),
       0, evidence.revision_zero_document(), repeat('d', 64), repeat('b', 64)) AS outcome`,
    [pkg, doc],
  );
  expect(committed.rows[0]?.outcome).toBe("reserved");
  await bindWithoutAnswer("zm1", doc);

  const { status, body } = await read(MARKO, "zm1");
  expect(status).toBe(200);
  expect(body.state).toBe("bound");
  expect(body.question).toMatchObject({ text: "Mentorsko pitanje?" });
  expect(body.questionAnswer).toBeNull();
});

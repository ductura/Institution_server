// SRV-1706, plan M10.4-P02 (PRODUCT §5 rule 17, D-150, DAN-294): the list of
// work-read-paths.ts against the migrated catalogue of the main database.
// 1. The functions the web role executes that reach a table holding the text
//    of a work, directly or through any function they call, are exactly those
//    the list names: a new content read without a decision fails here.
// 2. Each logged path reaches audit.record_work_opening and names its surfaces.
// 3. A teacher's read of a work writes the row; the owner's read writes none.
// Every person, work and text is invented (db/main/tests/fixtures).
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../../test-support/database/index.ts";

import { NOT_A_PERSON_READ, WORK_READ_PATHS } from "./work-read-paths.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const institution = readFileSync(new URL("institution.inc", FIXTURES), "utf8");
const evidence = readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
  /^\\ir institution\.inc\r?\n/mu,
  "",
);

// Tables that hold the text of a work or what a summary is built from.
const CONTENT = [
  "collaboration\\.live_state",
  "evidence\\.segment",
  "evidence\\.document_checkpoint",
  "evidence\\.reconstruction_checkpoint",
  "declaration\\.statement",
  "collaboration\\.teacher_edit",
].join("|");
const SCHEMAS = [
  "app",
  "collaboration",
  "evidence",
  "audit",
  "institution",
  "declaration",
  "identity",
  "assistant",
];
const SURFACES = "live_view|process_summary|fast_path|replay|submitted_text|declaration";

// One row per function the web role may execute: whether it reaches a content
// table and the writer, and the surfaces named by the functions on the way
// that call the writer. A call is a schema-qualified name followed by "(": the
// functions of these schemas run with an empty search_path, so every call
// names its schema. Each body is scanned once, so the walk is linear.
const CATALOGUE = `
WITH RECURSIVE fns AS (
  SELECT p.oid, n.nspname || '.' || p.proname AS name, p.prosrc,
         p.prosrc ~ ('(' || $2 || ')\\M') AS content,
         (p.prosrc ~ 'audit\\.record_work_opening\\('
           OR (n.nspname || '.' || p.proname = 'app.peer_review_work'
               AND p.prosrc ~ 'INSERT INTO audit\\.access_log')) AS logs
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = ANY ($1::text[])
), edges AS (
  SELECT DISTINCT a.oid AS caller, b.oid AS callee
  FROM fns a
  CROSS JOIN LATERAL regexp_matches(a.prosrc, '\\m([a-z_]+\\.[a-z_0-9]+)\\s*\\(', 'g') AS m (ref)
  JOIN fns b ON b.name = m.ref[1] AND b.oid <> a.oid
), reach (oid, root) AS (
  SELECT oid, oid FROM fns WHERE has_function_privilege('ductus_app', oid, 'EXECUTE')
  UNION
  SELECT e.callee, r.root FROM reach r JOIN edges e ON e.caller = r.oid
)
SELECT f.name,
       bool_or(g.content) AS content,
       bool_or(g.logs) AS logs,
       array_remove(array_agg(DISTINCT s.m[1]), NULL) AS surfaces
FROM reach r
JOIN fns f ON f.oid = r.root
JOIN fns g ON g.oid = r.oid
LEFT JOIN LATERAL (SELECT regexp_matches(g.prosrc, $3, 'g') AS m WHERE g.logs) s ON true
GROUP BY f.name
`;

type Catalogued = { name: string; content: boolean; logs: boolean; surfaces: string[] };

let db: TestDatabase;
let catalogue: Map<string, Catalogued>;

beforeAll(async () => {
  db = await createTestDatabase("main", { authority: true });
  const { rows } = await db.query<Catalogued>(CATALOGUE, [SCHEMAS, CONTENT, `'(${SURFACES})'`]);
  catalogue = new Map(rows.map((r) => [r.name, r]));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("the content reads of the web role (M10.4-P02)", () => {
  it("are exactly the listed paths", () => {
    const reaching = [...catalogue.values()]
      .filter((r) => r.content)
      .map((r) => r.name)
      .sort();
    const listed = [...WORK_READ_PATHS, ...NOT_A_PERSON_READ].map((p) => p.fn).sort();
    expect(reaching).toEqual(listed);
  });

  it.each(WORK_READ_PATHS.map((p) => [p.fn, p.surfaces] as const))(
    "%s writes audit.access_log with its surfaces",
    (fn, surfaces) => {
      const found = catalogue.get(fn);
      expect(found?.logs).toBe(true);
      expect([...(found?.surfaces ?? [])].sort()).toEqual([...surfaces].sort());
    },
  );

  it("no path left unlogged reaches the writer, so the list says what each does", () => {
    for (const path of NOT_A_PERSON_READ) expect(catalogue.get(path.fn)?.logs, path.fn).toBe(false);
  });
});

describe("a read writes the row of the reader, not the owner's", () => {
  // doc-a is Ana's work on Z1 of K1; Vesna teaches K1 (evidence-acceptance.inc).
  const reads: Record<string, (doc: string) => string> = {
    "collaboration.read_live_state": (doc) =>
      `SELECT outcome FROM collaboration.read_live_state('${doc}', repeat('0', 64))`,
    "app.read_process_summary_source": (doc) =>
      `SELECT outcome FROM app.read_process_summary_source('${doc}')`,
    "app.read_replay_source": (doc) => `SELECT outcome FROM app.read_replay_source('${doc}')`,
  };

  it.each(Object.keys(reads))("%s", async (fn) => {
    await db.reset();
    await db.exec(institution);
    await db.exec(evidence);
    const rows = async () =>
      (
        await db.query<{ who: string; surface: string }>(
          `SELECT p.name AS who, l.surface FROM audit.access_log l JOIN person p ON p.id = l.reader_id
            WHERE l.document_id = 'doc-a' ORDER BY 1, 2`,
        )
      ).rows;
    const sql = reads[fn]!("doc-a");
    const ask = async (who: string) =>
      (await db.query<{ v: string }>("SELECT pg_temp.ask($1, $2) AS v", [who, sql])).rows[0]?.v;

    expect(await ask("ana")).not.toMatch(/^ZD/);
    expect(await rows()).toEqual([]);
    // Another student of the course is refused, as the read refuses (an error or not_found).
    expect(await ask("dora")).toMatch(/^(ZD403|not_found$)/);
    expect(await rows()).toEqual([]);
    expect(await ask("vesna")).not.toMatch(/^ZD/);
    const path = WORK_READ_PATHS.find((p) => p.fn === fn);
    const written = await rows();
    expect(written.map((r) => r.who)).toEqual(["vesna"]);
    expect(path?.surfaces).toContain(written[0]?.surface);
  });
});

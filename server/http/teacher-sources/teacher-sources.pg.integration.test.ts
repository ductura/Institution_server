// The teacher source guidance port over the migrated database (SRV-1605): every
// answer of an RPC fits the closed contract of its route, the holder writes and
// a collaborator only reads, and a refusal is an outcome. Fixture people only
// (Vesna holds K1, Marko is a second teacher of K1, Ana is its student).
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";
import { createTestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../../database/index.ts";

import { createTeacherSources } from "../../database/index.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const text = (name: string) => readFileSync(new URL(name, FIXTURES), "utf8");
// evidence-acceptance.inc includes institution.inc with a psql \ir, which the
// test database does not run: the two are applied one after the other.
const EVIDENCE = text("evidence-acceptance.inc").replace(/^\\ir .*$/mu, "");
// The tokens are one letter per person in the order of their ids (institution.inc).
const VESNA = "A".repeat(43);
const MARKO = "B".repeat(43);
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const DOC = "doc-a";
const K1 = "00000000-0000-4000-8000-0000000000c1";
const Z1 = "00000000-0000-4000-8000-0000000000a1";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const record = {
  id: SOURCE,
  type: "book",
  year: 2024,
  authors: [{ kind: "person", family: "Izmišljenić", given: "Mara" }],
  title: "Kućno kompostiranje",
  place: "Zagreb",
  publisher: "Izmišljena naklada",
};

const bodyOf = (id: string) =>
  ROUTES.find((route) => route.id === id)!.responses.find((response) => response.status === 200)!
    .body!;

it("answers as the closed contracts say, writes only as the holder and refuses the rest", async () => {
  const db = await createTestDatabase("main", { authority: true });
  try {
    await db.exec(text("institution.inc"));
    await db.exec(EVIDENCE);
    const withActor: WithActor = async (token, run) => {
      await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
      await db.exec("SET LOCAL ROLE ductus_app");
      try {
        return await run({
          async query<Row>(sql: string, values?: readonly unknown[]) {
            const { rows } = await db.query<Row>(sql, [...(values ?? [])]);
            return { rows, rowCount: rows.length };
          },
        });
      } finally {
        await db.exec("RESET ROLE");
      }
    };
    await withActor(VESNA, (tx) =>
      tx.query("SELECT 1 FROM institution.set_course_holder($1::uuid, $2::uuid)", [
        K1,
        "00000000-0000-4000-8000-000000000101",
      ]),
    );
    await db.exec(
      "INSERT INTO institution.course_member (course_id, institution_id, user_id, role) VALUES ('" +
        K1 +
        "', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-000000000102', 'teacher')",
    );
    const sources = createTeacherSources(withActor);

    const empty = await sources.guidance(VESNA, DOC);
    expect(empty.status).toBe("ok");
    if (empty.status !== "ok") throw new Error("no guidance");
    expect(Value.Check(bodyOf("teacher.source-guidance.get"), empty.value)).toBe(true);
    expect(empty.value).toMatchObject({ canWrite: true, sources: [], literatureSeenAt: null });
    const collaborator = await sources.guidance(MARKO, DOC);
    expect(collaborator).toMatchObject({ status: "ok", value: { canWrite: false } });
    expect(await sources.guidance(ANA, DOC)).toEqual({ status: "not_found" });
    expect(await sources.guidance(DORA, DOC)).toEqual({ status: "not_found" });

    const saved = await sources.recommend(VESNA, DOC, {
      record,
      requirement: "required",
      doi: "10.1000/izmisljeno-1",
    });
    expect(saved).toMatchObject({
      status: "ok",
      value: { id: SOURCE, requirement: "required", doi: "10.1000/izmisljeno-1", isbn: null },
    });
    if (saved.status !== "ok") throw new Error("not saved");
    expect(Value.Check(bodyOf("teacher.source-recommendation.put"), saved.value)).toBe(true);
    expect(await sources.recommend(MARKO, DOC, { record, requirement: "required" })).toEqual({
      status: "not_found",
    });
    expect(
      await sources.recommend(VESNA, DOC, { record, requirement: "required", doi: "10.1000/ABC" }),
    ).toEqual({ status: "invalid_input" });

    const due = new Date(Date.now() + 86_400_000).toISOString();
    const request = await sources.putProofRequest(VESNA, DOC, SOURCE, {
      instruction: "Priložite stranicu 14.",
      dueAt: due,
    });
    expect(request).toMatchObject({ status: "ok", value: { sourceId: SOURCE, closedAt: null } });
    if (request.status !== "ok") throw new Error("no request");
    expect(Value.Check(bodyOf("teacher.source-proof-request.put"), request.value)).toBe(true);
    expect(
      await sources.putProofRequest(VESNA, DOC, SOURCE, {
        instruction: "Prekasno.",
        dueAt: "2020-01-01T00:00:00.000Z",
      }),
    ).toEqual({ status: "invalid_input" });
    const own = await sources.studentProofRequests(ANA, Z1);
    expect(own).toMatchObject({ status: "ok", value: { proofRequests: [{ sourceId: SOURCE }] } });
    if (own.status !== "ok") throw new Error("student read");
    expect(Value.Check(bodyOf("student.source-proof-requests.get"), own.value)).toBe(true);
    expect(await sources.studentProofRequests(VESNA, Z1)).toEqual({ status: "not_found" });

    const seen = await sources.markLiteratureSeen(VESNA, DOC);
    expect(seen).toMatchObject({ status: "ok" });
    expect(await sources.markLiteratureSeen(MARKO, DOC)).toEqual({ status: "not_found" });

    await withActor(ANA, (tx) =>
      tx.query(
        "SELECT 1 FROM institution.add_source_proof($1::uuid, $2::uuid, '14', NULL, $3::bytea)",
        [Z1, SOURCE, Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
      ),
    );
    const proofs = await sources.proofs(MARKO, DOC, SOURCE);
    expect(proofs).toMatchObject({ status: "ok", value: [{ page: "14", note: null }] });
    if (proofs.status !== "ok") throw new Error("proofs");
    const image = await sources.image(MARKO, DOC, SOURCE, proofs.value[0]!.id);
    expect(image).toMatchObject({ status: "ok" });
    if (image.status !== "ok") throw new Error("image");
    expect(image.value.image.equals(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBe(true);
    expect(await sources.proofs(ANA, DOC, SOURCE)).toEqual({ status: "not_found" });

    const full = await sources.guidance(MARKO, DOC);
    if (full.status !== "ok") throw new Error("guidance");
    expect(Value.Check(bodyOf("teacher.source-guidance.get"), full.value)).toBe(true);
    expect(full.value).toMatchObject({
      sources: [{ proofCount: 1 }],
      proofRequests: [{}],
      literatureSeenAt: expect.any(String),
    });

    const course = await sources.putCourseSource(VESNA, K1, {
      record,
      doi: "10.1000/izmisljeno-2",
    });
    expect(course).toMatchObject({ status: "ok", value: { id: SOURCE } });
    if (course.status !== "ok") throw new Error("course");
    expect(Value.Check(bodyOf("teacher.course-literature.put"), course.value)).toBe(true);
    expect(await sources.putCourseSource(MARKO, K1, { record })).toEqual({ status: "not_found" });
    const other = { ...record, id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
    expect(
      await sources.putCourseSource(VESNA, K1, { record: other, doi: "10.1000/izmisljeno-2" }),
    ).toEqual({ status: "conflict" });
    for (const [token, writes] of [
      [VESNA, true],
      [MARKO, false],
      [ANA, false],
    ] as const) {
      const read = await sources.courseLiterature(token, K1);
      expect(read).toMatchObject({ status: "ok", value: { canWrite: writes } });
      if (read.status !== "ok") throw new Error("literature");
      expect(Value.Check(bodyOf("teacher.course-literature.get"), read.value)).toBe(true);
    }
    expect(await sources.courseLiterature(DORA, "00000000-0000-4000-8000-0000000000c3")).toEqual({
      status: "not_found",
    });
    expect(await sources.deleteCourseSource(MARKO, K1, SOURCE)).toEqual({ status: "not_found" });
    expect(await sources.deleteCourseSource(VESNA, K1, SOURCE)).toEqual({
      status: "ok",
      value: true,
    });

    expect(await sources.unrecommend(MARKO, DOC, SOURCE)).toEqual({ status: "not_found" });
    expect(await sources.unrecommend(VESNA, DOC, SOURCE)).toEqual({ status: "ok", value: true });
    expect(await sources.unrecommend(VESNA, DOC, SOURCE)).toEqual({ status: "ok", value: false });
    expect(await sources.guidance("Z".repeat(43), DOC)).toEqual({ status: "unauthorized" });
  } finally {
    await db.close();
  }
});

// SRV-ED42-PRIJEDLOZI: the suggestions port over the migrated PostgreSQL, as
// ductus_app with the session of each invented persona of institution.inc and
// evidence-acceptance.inc (Vesna teaches K1, Ana writes doc-a in it, Dora is
// another student of K1, Marko teaches K2, Tomo writes doc-b in fak-b). Each
// call is a real transaction, so a refused accept is shown to be rolled back.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "../../../test-support/database/index.ts";
import type { WithActor } from "../index.ts";

import { applySuggestionToLive, createSuggestions, type Suggestions } from "./suggestions.ts";

const FIXTURES = new URL("../../../db/main/tests/fixtures/", import.meta.url);
const NODE = "0f1e2d3c-4b5a-4968-8776-655443322110";
const TEXT = "Izmišljeni grad ima tri trga.";
const snapshot = (text: string) =>
  `{"nodes":[{"children":[{"marks":[],"text":"${text}","type":"text"}],"id":"${NODE}","type":"paragraph"}],"schemaVersion":1}`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ANCHOR = {
  nodeId: NODE,
  quote: "tri trga",
  prefix: "ima ",
  suffix: ".",
  startHint: 20,
  endHint: 28,
};
const VESNA = "A".repeat(43);
const MARKO = "B".repeat(43);
const ANA = "D".repeat(43);
const DORA = "E".repeat(43);
const TOMO = "J".repeat(43);

let db: TestDatabase;
let store: Suggestions;
let withActor: WithActor;

beforeAll(async () => {
  db = await createTestDatabase("main", { authority: true });
  await db.exec(readFileSync(new URL("institution.inc", FIXTURES), "utf8"));
  await db.exec(
    readFileSync(new URL("evidence-acceptance.inc", FIXTURES), "utf8").replace(
      /^\\ir institution\.inc\r?\n/mu,
      "",
    ),
  );
  // The test database runs in a transaction of its own, so the calls here
  // are not separate transactions: a refused accept is rolled back by
  // withActor in production, which suggestions.test.ts shows (it throws).
  withActor = async (token, run) => {
    await db.query("SELECT set_config('app.session_token', $1, true)", [token]);
    await db.exec("SET LOCAL ROLE ductus_app");
    try {
      return await run({
        async query<Row>(sql: string, args?: readonly unknown[]) {
          const { rows } = await db.query<Row>(sql, [...(args ?? [])]);
          return { rows, rowCount: rows.length };
        },
      });
    } finally {
      await db.exec("RESET ROLE");
    }
  };
  store = createSuggestions(withActor);
  const published = await withActor(ANA, (tx) =>
    tx.query("SELECT outcome FROM collaboration.publish_live_state('doc-a', NULL, $1)", [
      snapshot(TEXT),
    ]),
  );
  expect(published.rows).toEqual([{ outcome: "accepted" }]);
});

afterAll(async () => {
  await db?.close();
});

const evidence = async () =>
  (
    await db.query(
      `SELECT (SELECT json_agg(d ORDER BY d.id) FROM evidence.document d) AS documents,
              (SELECT json_agg(r ORDER BY r.document_id, r.revision) FROM evidence.document_revision r) AS revisions,
              (SELECT json_agg(l ORDER BY l.document_id) FROM collaboration.live_state l) AS live`,
    )
  ).rows;

describe("suggestions over PostgreSQL", () => {
  it("a teacher suggests, both sides list, the owner accepts once, and the work stays as it was", async () => {
    const before = await evidence();
    const created = await store.create(VESNA, "doc-a", ANCHOR, "četiri trga");
    expect(created).toMatchObject({ status: "ok", baseHash: sha(snapshot(TEXT)) });
    if (created.status !== "ok") return;

    for (const [token, isOwn] of [
      [VESNA, true],
      [ANA, false],
    ] as const) {
      const listed = await store.list(token, "doc-a");
      expect(listed).toMatchObject({
        status: "ok",
        suggestions: [
          { suggestionId: created.suggestionId, state: "pending", isOwn, text: "četiri trga" },
        ],
      });
    }

    // The teacher of the work cannot decide; nobody else even sees it.
    expect(await store.accept(VESNA, created.suggestionId, applySuggestionToLive)).toEqual({
      status: "forbidden",
    });
    expect(await store.reject(VESNA, created.suggestionId)).toEqual({ status: "forbidden" });
    for (const token of [DORA, MARKO, TOMO]) {
      expect(await store.accept(token, created.suggestionId, applySuggestionToLive)).toEqual({
        status: "not_found",
      });
      expect(await store.list(token, "doc-a")).toEqual({ status: "not_found" });
    }

    const accepted = await store.accept(ANA, created.suggestionId, applySuggestionToLive);
    expect(accepted).toMatchObject({
      status: "ok",
      baseHash: sha(snapshot(TEXT)),
      applied: {
        text: snapshot("Izmišljeni grad ima četiri trga."),
        change: {
          source: "teacher-suggestion",
          suggestionId: created.suggestionId,
          nodeId: NODE,
          start: 20,
          end: 28,
          removed: "tri trga",
          inserted: "četiri trga",
        },
      },
    });
    // A second decision is refused, either way.
    expect(await store.accept(ANA, created.suggestionId, applySuggestionToLive)).toEqual({
      status: "conflict",
    });
    expect(await store.reject(ANA, created.suggestionId)).toEqual({ status: "conflict" });
    // The teacher's input entered neither the evidence nor the live state.
    expect(await evidence()).toEqual(before);
  });

  it("refuses the owner as author, another's work and a stale anchor; a rejected suggestion stays rejected", async () => {
    expect(await store.create(ANA, "doc-a", ANCHOR, "drugi")).toEqual({ status: "forbidden" });
    for (const [token, work] of [
      [DORA, "doc-a"],
      [MARKO, "doc-a"],
      [TOMO, "doc-a"],
      [VESNA, "doc-b"],
      [VESNA, "doc-nema"],
    ] as const) {
      expect(await store.create(token, work, ANCHOR, "drugi")).toEqual({ status: "not_found" });
    }
    expect(await store.create(VESNA, "doc-a", { ...ANCHOR, quote: "dva trga" }, "x")).toEqual({
      status: "conflict",
    });
    expect(await store.create(VESNA, "doc-a", ANCHOR, "tri trga")).toEqual({ status: "invalid" });

    // The owner rejects a pending suggestion; the work does not change.
    const created = await store.create(VESNA, "doc-a", ANCHOR, "pet trgova");
    if (created.status !== "ok") throw new Error("create failed");
    expect(await store.reject(ANA, created.suggestionId)).toEqual({ status: "ok" });
    expect(await store.accept(ANA, created.suggestionId, applySuggestionToLive)).toEqual({
      status: "conflict",
    });
    const after = await store.list(VESNA, "doc-a");
    expect(after.status === "ok" && after.suggestions.at(-1)?.state).toBe("rejected");
    // A live state that moved on no longer takes the anchor of the old one.
    const current = (
      await db.query<{ write_token: string }>(
        "SELECT write_token FROM collaboration.live_state WHERE document_id = 'doc-a'",
      )
    ).rows[0]!.write_token;
    await withActor(ANA, (tx) =>
      tx.query("SELECT outcome FROM collaboration.publish_live_state('doc-a', $1, $2)", [
        current,
        snapshot("Izmišljeni grad nema trgova."),
      ]),
    );
    expect(await store.create(VESNA, "doc-a", ANCHOR, "šest trgova")).toEqual({
      status: "conflict",
    });
  });
});

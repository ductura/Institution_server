// SRV-NG: the notice of the current version for a student of the course or of
// the mentorship (SRV-MENTOR-NOTICE), over a fake withActor. Who asks comes
// only from the session; a row the port cannot vouch for is row_malformed. Every token, id and text is invented.
import { describe, expect, it } from "vitest";

import {
  createStudentNoticeReader,
  noticeOf,
  STUDENT_NOTICE_DATABASE_ERROR,
  STUDENT_NOTICE_NOT_FOUND,
  STUDENT_NOTICE_ROW_MALFORMED,
  STUDENT_NOTICE_UNAUTHENTICATED,
} from "./student-notice.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const A = "3c9f0a1e-7b2d-4e5f-8a6b-1c2d3e4f5a60";
const USER = "5a000000-0000-4000-8000-000000000001";
// The columns as the driver names them; built from entries, as they are no camelCase names.
const BASE: readonly (readonly [string, unknown])[] = [
  ["assignment_id", A],
  ["version_no", 2],
  ["title", "Seminarski rad: kućno kompostiranje"],
  ["instructions", "Izmišljena uputa."],
  ["work_type", "seminar_paper"],
  ["opens_at", new Date("2026-11-02T08:00:00.000Z")],
  ["due_at", new Date("2026-12-15T22:59:00.000Z")],
  ["ai_policy", "prohibited"],
  ["ai_purposes", []],
  ["evidence_profile", "extended"],
  ["word_min", null],
  ["word_max", 3000],
  ["read_at", null],
  ["acknowledged_at", new Date("2026-11-03T09:20:00.000Z")],
  ["purpose_catalog_version", 1],
  ["ai_summary_only", false],
  // A first version: no previous one, every prev_* column null.
  ...[
    "version_no",
    "title",
    "instructions",
    "work_type",
    "opens_at",
    "due_at",
    "ai_policy",
    "ai_purposes",
    "evidence_profile",
    "word_min",
    "word_max",
  ].map((key) => [`prev_${key}`, null] as const),
];
// F4-STU-R11-SRV: version 1 below the current version 2.
const PREVIOUS: readonly (readonly [string, unknown])[] = [
  ["prev_version_no", 1],
  ["prev_title", "Seminarski rad"],
  ["prev_instructions", "Izmišljena prva uputa."],
  ["prev_work_type", "essay"],
  ["prev_opens_at", new Date("2026-11-01T08:00:00.000Z")],
  ["prev_due_at", new Date("2026-12-08T22:59:00.000Z")],
  ["prev_ai_policy", "partially_allowed"],
  ["prev_ai_purposes", ["proofreading"]],
  ["prev_evidence_profile", "basic"],
  ["prev_word_min", 1000],
  ["prev_word_max", null],
];
const row = (...over: (readonly [string, unknown])[]): object =>
  Object.fromEntries([...BASE, ...over]);
const actorRow = (id: unknown): object => Object.fromEntries([["user_id", id]]);

function reader(actor: unknown[], notice: unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        if (notice instanceof Error) throw notice;
        return {
          rows: (text.includes("current_user_id() AS user_id") ? actor : notice) as never[],
          rowCount: 0,
        };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createStudentNoticeReader(withActor), seen };
}
const fail = (error: unknown) => ({ ok: false, error });

describe("student notice", () => {
  it("reads the notice with instants as toISOString and null bounds kept", async () => {
    const { port, seen } = reader([actorRow(USER)], [row()]);
    expect(await port.read(TOKEN, A)).toEqual({
      ok: true,
      value: {
        assignmentId: A,
        versionNo: 2,
        title: "Seminarski rad: kućno kompostiranje",
        instructions: "Izmišljena uputa.",
        workType: "seminar_paper",
        opensAt: "2026-11-02T08:00:00.000Z",
        dueAt: "2026-12-15T22:59:00.000Z",
        aiPolicy: "prohibited",
        aiPurposes: [],
        evidenceProfile: "extended",
        wordMin: null,
        wordMax: 3000,
        readAt: null,
        acknowledgedAt: "2026-11-03T09:20:00.000Z",
        purposeCatalogVersion: 1,
        aiSummaryOnly: false,
        previousVersion: null,
      },
    });
    expect(seen[1]!.values).toEqual([A]);
  });

  it("asks for a student of the assignment, by course or by mentorship, never the role alone", async () => {
    const { port, seen } = reader([actorRow(USER)], [row()]);
    await port.read(TOKEN, A);
    const text = seen[1]!.text;
    // SRV-MENTOR-NOTICE: one helper covers both relations (course and open
    // mentorship); joining course_member alone left a mentorship's notice 404.
    expect(text).toContain(
      "a.id = ANY ((SELECT institution.actor_assignment_ids('{student}'))::uuid[])",
    );
    expect(text).not.toMatch(/teacher|course_member/u);
    // read_at and acknowledged_at are the caller's own, from the session.
    expect(text.match(/student_id = \(SELECT app\.current_user_id\(\)\)/gu)).toHaveLength(2);
  });

  it("a session that no longer stands is unauthenticated; no row is not_found", async () => {
    expect(await reader([actorRow(null)], [row()]).port.read(TOKEN, A)).toEqual(
      fail(STUDENT_NOTICE_UNAUTHENTICATED),
    );
    expect(await reader([actorRow(USER)], []).port.read(TOKEN, A)).toEqual(
      fail(STUDENT_NOTICE_NOT_FOUND),
    );
  });

  it("a malformed token or id never reaches the database", async () => {
    const a = reader([actorRow(USER)], [row()]);
    expect(await a.port.read("kratko", A)).toEqual(fail(STUDENT_NOTICE_UNAUTHENTICATED));
    expect(await a.port.read(TOKEN, "nije-uuid")).toEqual(fail(STUDENT_NOTICE_NOT_FOUND));
    expect(a.seen).toEqual([]);
  });

  it("maps database errors", async () => {
    expect(
      await reader([], Object.assign(new Error("x"), { code: "ZD401" })).port.read(TOKEN, A),
    ).toEqual(fail(STUDENT_NOTICE_UNAUTHENTICATED));
    expect(
      await reader([], Object.assign(new Error("x"), { code: "57014" })).port.read(TOKEN, A),
    ).toEqual(fail(STUDENT_NOTICE_DATABASE_ERROR));
  });

  it("a row it cannot vouch for is row_malformed", async () => {
    const bads: readonly (readonly [string, unknown])[] = [
      ["version_no", 0],
      ["opens_at", "2026-11-02"],
      ["word_min", 0],
      ["ai_purposes", [1]],
      ["title", ""],
      ["purpose_catalog_version", 0],
      ["purpose_catalog_version", "1"],
      ["purpose_catalog_version", null],
      ["ai_summary_only", null],
      ["ai_summary_only", "false"],
    ];
    for (const bad of bads) {
      expect(await reader([actorRow(USER)], [row(bad)]).port.read(TOKEN, A)).toEqual(
        fail(STUDENT_NOTICE_ROW_MALFORMED),
      );
    }
    expect(noticeOf([row(), row()])).toBeNull();
  });

  it("reads the purpose catalog of the version, as the assistant request sends it back", async () => {
    const { port, seen } = reader([actorRow(USER)], [row(["purpose_catalog_version", 2])]);
    const read = await port.read(TOKEN, A);
    expect(read.ok && read.value.purposeCatalogVersion).toBe(2);
    expect(seen[1]!.text).toContain("v.purpose_catalog_version");
  });

  it("reads whether the assistant only summarises, from the assignment (SRV-EDI-R08)", async () => {
    const { port, seen } = reader([actorRow(USER)], [row(["ai_summary_only", true])]);
    const read = await port.read(TOKEN, A);
    expect(read.ok && read.value.aiSummaryOnly).toBe(true);
    expect(seen[1]!.text).toContain("a.ai_summary_only");
  });

  it("reads the version below the current one as previousVersion (F4-STU-R11-SRV)", async () => {
    const { port, seen } = reader([actorRow(USER)], [row(...PREVIOUS)]);
    const read = await port.read(TOKEN, A);
    expect(read.ok && read.value.previousVersion).toEqual({
      versionNo: 1,
      title: "Seminarski rad",
      instructions: "Izmišljena prva uputa.",
      workType: "essay",
      opensAt: "2026-11-01T08:00:00.000Z",
      dueAt: "2026-12-08T22:59:00.000Z",
      aiPolicy: "partially_allowed",
      aiPurposes: ["proofreading"],
      evidenceProfile: "basic",
      wordMin: 1000,
      wordMax: null,
    });
    // The highest earlier version of the same assignment, under the same read policy.
    expect(seen[1]!.text).toContain("q.version_no < a.current_version");
    expect(seen[1]!.text).toContain("LEFT JOIN institution.assignment_version p");
  });

  it("a previous version it cannot vouch for is row_malformed", async () => {
    const bads: readonly (readonly [string, unknown])[] = [
      ["prev_version_no", 2],
      ["prev_version_no", 3],
      ["prev_title", null],
      ["prev_opens_at", "2026-11-01"],
      ["prev_ai_purposes", [1]],
      ["prev_word_max", 0],
    ];
    for (const bad of bads) {
      expect(await reader([actorRow(USER)], [row(...PREVIOUS, bad)]).port.read(TOKEN, A)).toEqual(
        fail(STUDENT_NOTICE_ROW_MALFORMED),
      );
    }
    // A row without the prev_* columns is not a first version.
    const bare = Object.fromEntries(BASE.filter(([key]) => !key.startsWith("prev_")));
    expect(noticeOf([bare])).toBeNull();
  });
});

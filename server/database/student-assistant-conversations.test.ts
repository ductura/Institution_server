// SRV-ASIST-CITANJE: the caller's own assistant conversations of an assignment,
// over a fake withActor. Who asks comes only from the session; another's
// assignment is not_found; a row the port cannot vouch for is row_malformed.
// Every token, id and text is invented.
import { describe, expect, it } from "vitest";

import {
  conversationsOf,
  createStudentConversationsReader,
  STUDENT_CONVERSATIONS_DATABASE_ERROR,
  STUDENT_CONVERSATIONS_NOT_FOUND,
  STUDENT_CONVERSATIONS_ROW_MALFORMED,
  STUDENT_CONVERSATIONS_UNAUTHENTICATED,
} from "./student-assistant-conversations.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const A = "3c9f0a1e-7b2d-4e5f-8a6b-1c2d3e4f5a60";
const C1 = "7d000000-0000-4000-8000-000000000001";
const USER = "5a000000-0000-4000-8000-000000000001";
const BASE: readonly (readonly [string, unknown])[] = [
  ["conversation_id", C1],
  ["purpose_key", "proofreading"],
  ["created_at", new Date("2026-11-20T10:00:00.000Z")],
  ["request_count", 3],
  ["last_activity_at", new Date("2026-11-21T08:30:00.000Z")],
];
const row = (...over: (readonly [string, unknown])[]): object =>
  Object.fromEntries([...BASE, ...over]);
const one = (key: string, value: unknown): object => Object.fromEntries([[key, value]]);

function reader(actor: unknown[], student: unknown[], list: unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        if (list instanceof Error) throw list;
        const rows = text.includes("AS user_id")
          ? actor
          : text.includes("AS student")
            ? student
            : list;
        return { rows: rows as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createStudentConversationsReader(withActor), seen };
}
const fail = (error: unknown) => ({ ok: false, error });
const member = [one("student", true)];

describe("student assistant conversations", () => {
  it("lists the conversations with instants as toISOString, without message text", async () => {
    const { port, seen } = reader([one("user_id", USER)], member, [row()]);
    expect(await port.read(TOKEN, A)).toEqual({
      ok: true,
      value: [
        {
          conversationId: C1,
          purposeKey: "proofreading",
          createdAt: "2026-11-20T10:00:00.000Z",
          requestCount: 3,
          lastActivityAt: "2026-11-21T08:30:00.000Z",
        },
      ],
    });
    expect(seen.slice(1).map((s) => s.values)).toEqual([[A], [A]]);
    expect(seen[2]!.text).not.toMatch(/content|message/u);
  });

  it("asks for a student of the assignment and for the session's own conversations only", async () => {
    const { port, seen } = reader([one("user_id", USER)], member, []);
    await port.read(TOKEN, A);
    expect(seen[1]!.text).toContain("institution.actor_assignment_ids('{student}')");
    expect(seen[2]!.text).toContain("c.student_id = (SELECT app.current_user_id())");
    expect(seen.map((s) => s.text).join("\n")).not.toMatch(/teacher|course_member/u);
  });

  it("an assignment of which the caller is a student but without a conversation is an empty list", async () => {
    expect(await reader([one("user_id", USER)], member, []).port.read(TOKEN, A)).toEqual({
      ok: true,
      value: [],
    });
  });

  it("another's or an unknown assignment is not_found, even with rows", async () => {
    for (const student of [[one("student", false)], [one("student", null)]]) {
      expect(await reader([one("user_id", USER)], student, [row()]).port.read(TOKEN, A)).toEqual(
        fail(STUDENT_CONVERSATIONS_NOT_FOUND),
      );
    }
  });

  it("a session that no longer stands is unauthenticated", async () => {
    expect(await reader([one("user_id", null)], member, [row()]).port.read(TOKEN, A)).toEqual(
      fail(STUDENT_CONVERSATIONS_UNAUTHENTICATED),
    );
  });

  it("a malformed token or id never reaches the database", async () => {
    const a = reader([one("user_id", USER)], member, [row()]);
    expect(await a.port.read("kratko", A)).toEqual(fail(STUDENT_CONVERSATIONS_UNAUTHENTICATED));
    expect(await a.port.read(TOKEN, "nije-uuid")).toEqual(fail(STUDENT_CONVERSATIONS_NOT_FOUND));
    expect(await a.port.read(TOKEN, A.toUpperCase())).toEqual(
      fail(STUDENT_CONVERSATIONS_NOT_FOUND),
    );
    expect(a.seen).toEqual([]);
  });

  it("maps database errors", async () => {
    const thrown = (code: string) => Object.assign(new Error("x"), { code });
    expect(await reader([], [], thrown("ZD401")).port.read(TOKEN, A)).toEqual(
      fail(STUDENT_CONVERSATIONS_UNAUTHENTICATED),
    );
    expect(await reader([], [], thrown("57014")).port.read(TOKEN, A)).toEqual(
      fail(STUDENT_CONVERSATIONS_DATABASE_ERROR),
    );
  });

  it("a row it cannot vouch for is row_malformed, never a partial list", async () => {
    const bads: readonly (readonly [string, unknown])[] = [
      ["conversation_id", "nije-uuid"],
      ["purpose_key", "Lektura"],
      ["purpose_key", null],
      ["request_count", 0],
      ["request_count", "3"],
      ["created_at", "2026-11-20"],
      ["last_activity_at", new Date("2026-11-19T00:00:00.000Z")],
    ];
    for (const bad of bads) {
      expect(
        await reader([one("user_id", USER)], member, [row(), row(bad)]).port.read(TOKEN, A),
      ).toEqual(fail(STUDENT_CONVERSATIONS_ROW_MALFORMED));
    }
    expect(
      await reader([one("user_id", USER)], [one("student", "da")], []).port.read(TOKEN, A),
    ).toEqual(fail(STUDENT_CONVERSATIONS_ROW_MALFORMED));
    expect(conversationsOf(null)).toBeNull();
  });
});

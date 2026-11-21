// SRV-1207 (M9.0-S3, Ductus#2052): the database port of the assistant's
// tools, step 3 of Ductus docs/contracts/ai-tools-v1.md (migration
// 20261130100200_assistant_tools). Each call is one withActor transaction
// over one RPC of schema assistant: the teacher's setting of an assignment
// (set_assignment_tools, read_assignment_tools) and the steps of the AI
// route's tool loop (begin_tool_step, finish_tool_step). The database decides
// the relation, the policy, the setting in force and the order of outcomes;
// nothing here widens the set the route hands in (S3-D1, S3-Z1).
//
// The answer is a closed status, never a database message or SQLSTATE: ZD401
// unauthenticated, ZD403 forbidden (one answer for "not yours" and "not
// there"), ZD409 version_conflict for the setting and conflict for a step,
// ZD422 invalid, anything else unavailable. A row of an unexpected shape is
// unavailable too.
import type { ActorTransaction, WithActor } from "../index.ts";

/** The outcomes begin_tool_step writes (contract, "RPC-ovi"). */
export const TOOL_STEP_BEGIN_OUTCOMES = Object.freeze([
  "allowed",
  "denied_not_in_set",
  "denied_schema",
  "denied_revoked",
] as const);
export type ToolStepBeginOutcome = (typeof TOOL_STEP_BEGIN_OUTCOMES)[number];

export type AssistantToolsRefusal = {
  readonly status:
    "unauthenticated" | "forbidden" | "invalid" | "version_conflict" | "conflict" | "unavailable";
};

export type ToolStepInput = {
  readonly requestId: string;
  readonly stepNo: number;
  /** A member of the code set, or null for any other requested name. */
  readonly toolName: string | null;
  readonly requestedNameSha256: string;
  readonly argsSha256: string;
  readonly argsValid: boolean;
  /** What the server permits now: the code set ∩ switch ∩ ready. */
  readonly offeredTools: readonly string[];
};

export type ToolStepFinish = {
  readonly requestId: string;
  readonly stepNo: number;
} & (
  | {
      readonly outcome: "done";
      readonly resultSha256: string;
      readonly resultBytes: number;
      readonly truncated: boolean;
    }
  | { readonly outcome: "failed" }
);

export type AssistantTools = {
  setAssignmentTools(
    token: string,
    assignmentId: string,
    expectedVersion: number,
    tools: readonly string[],
  ): Promise<{ readonly status: "ok"; readonly version: number } | AssistantToolsRefusal>;
  readAssignmentTools(
    token: string,
    assignmentId: string,
  ): Promise<
    | { readonly status: "ok"; readonly version: number; readonly tools: readonly string[] }
    | AssistantToolsRefusal
  >;
  beginToolStep(
    token: string,
    input: ToolStepInput,
  ): Promise<
    | {
        readonly status: "ok";
        readonly outcome: ToolStepBeginOutcome;
        /** The allowed set for the next provider call. */
        readonly tools: readonly string[];
      }
    | AssistantToolsRefusal
  >;
  finishToolStep(
    token: string,
    input: ToolStepFinish,
  ): Promise<
    { readonly status: "ok"; readonly outcome: "done" | "failed" } | AssistantToolsRefusal
  >;
};

export const ASSISTANT_TOOLS_SQL = Object.freeze({
  set: "SELECT assistant.set_assignment_tools($1, $2, $3::text[]) AS version",
  read: 'SELECT version_no AS "version", tools FROM assistant.read_assignment_tools($1)',
  begin: "SELECT outcome, tools FROM assistant.begin_tool_step($1, $2, $3, $4, $5, $6, $7::text[])",
  finish: "SELECT assistant.finish_tool_step($1, $2, $3, $4, $5, $6) AS outcome",
});

class Malformed extends Error {}

function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

function refusal(
  thrown: unknown,
  conflict: AssistantToolsRefusal["status"],
): AssistantToolsRefusal {
  const code = codeOf(thrown);
  if (code === "ZD401") return { status: "unauthenticated" };
  if (code === "ZD403") return { status: "forbidden" };
  if (code === "ZD409") return { status: conflict };
  if (code === "ZD422") return { status: "invalid" };
  return { status: "unavailable" };
}

function only(rows: Record<string, unknown>[]): Record<string, unknown> {
  if (rows.length !== 1) throw new Malformed();
  return rows[0]!;
}

function toolList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !(value as unknown[]).every((name) => typeof name === "string"))
    throw new Malformed();
  return Object.freeze([...(value as string[])]);
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Malformed();
  return value;
}

export function createAssistantTools(withActor: WithActor): AssistantTools {
  async function run<T>(
    token: string,
    conflict: AssistantToolsRefusal["status"],
    fn: (tx: ActorTransaction) => Promise<T>,
  ): Promise<T | AssistantToolsRefusal> {
    try {
      return await withActor(token, fn);
    } catch (thrown) {
      return thrown instanceof Malformed ? { status: "unavailable" } : refusal(thrown, conflict);
    }
  }
  const one = async (tx: ActorTransaction, sql: string, params: unknown[]) =>
    only((await tx.query<Record<string, unknown>>(sql, params)).rows);

  return {
    setAssignmentTools: (token, assignmentId, expectedVersion, tools) =>
      run(token, "version_conflict", async (tx) => {
        const row = await one(tx, ASSISTANT_TOOLS_SQL.set, [
          assignmentId,
          expectedVersion,
          [...tools],
        ]);
        return { status: "ok" as const, version: version(row["version"]) };
      }),
    readAssignmentTools: (token, assignmentId) =>
      run(token, "conflict", async (tx) => {
        const row = await one(tx, ASSISTANT_TOOLS_SQL.read, [assignmentId]);
        return {
          status: "ok" as const,
          version: version(row["version"]),
          tools: toolList(row["tools"]),
        };
      }),
    beginToolStep: (token, input) =>
      run(token, "conflict", async (tx) => {
        const row = await one(tx, ASSISTANT_TOOLS_SQL.begin, [
          input.requestId,
          input.stepNo,
          input.toolName,
          input.requestedNameSha256,
          input.argsSha256,
          input.argsValid,
          [...input.offeredTools],
        ]);
        const outcome = row["outcome"];
        if (
          typeof outcome !== "string" ||
          !(TOOL_STEP_BEGIN_OUTCOMES as readonly string[]).includes(outcome)
        ) {
          throw new Malformed();
        }
        return {
          status: "ok" as const,
          outcome: outcome as ToolStepBeginOutcome,
          tools: toolList(row["tools"]),
        };
      }),
    finishToolStep: (token, input) =>
      run(token, "conflict", async (tx) => {
        const done = input.outcome === "done";
        const row = await one(tx, ASSISTANT_TOOLS_SQL.finish, [
          input.requestId,
          input.stepNo,
          input.outcome,
          done ? input.resultSha256 : null,
          done ? input.resultBytes : null,
          done ? input.truncated : null,
        ]);
        const outcome = row["outcome"];
        if (outcome !== "done" && outcome !== "failed") throw new Malformed();
        return { status: "ok" as const, outcome };
      }),
  };
}

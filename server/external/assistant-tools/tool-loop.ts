/**
 * The tool loop of the AI route (Ductus docs/contracts/ai-tools-v1.md,
 * "Izračun i provjera po koraku", "Granice izlaza", "Trošak petlje alata" and
 * "RPC-ovi"; plan #1664 S3-D2, S3-I1 to S3-I4, S3-Z1).
 *
 * One request after `mark_sent`: call the port with the allowed set, and
 * while the port answers with `tool_calls`, record each call as one step
 * through `begin_tool_step` (committed before anything runs or the provider
 * is called again), run an allowed `web_search` only through the search
 * guard, and hand the result back as a `tool_result` data part. A denied step
 * goes back as a `tool_denied` part whose text is its outcome code. The
 * instructions never change between calls (S3-U4).
 *
 * Bounds: a port output that asks for more calls than steps remain, or any
 * tool call of a request without a loop, ends with `tool_step_limit` without
 * another provider call; a `denied_revoked` step ends with `request_revoked`
 * without another provider call; an answer above RESPONSE_MAX_BYTES ends with
 * `response_too_large` and is not stored. The cost is the sum of every call.
 * A tool request counts only from the structured `tool_calls` field: nothing
 * reads commands from answer text (S3-I4).
 */
import { createHash } from "node:crypto";

import {
  assembleDataParts,
  buildPortInput,
  checkResponse,
  stepsOf,
  TOOL_STEP_MAX,
  toolResultPart,
  utf8ByteLength,
  type AssistantPortInput,
  type AssistantPortOutcome,
  type DataPart,
  type ToolName,
} from "../../domain/index.ts";

import type { SearchGuard } from "./search-guard.ts";

export type BeginStep = (input: {
  readonly stepNo: number;
  readonly toolName: ToolName | null;
  readonly requestedNameSha256: string;
  readonly argsSha256: string;
  readonly argsValid: boolean;
}) => Promise<
  | {
      readonly status: "ok";
      readonly outcome: "allowed" | "denied_not_in_set" | "denied_schema" | "denied_revoked";
      readonly tools: readonly string[];
    }
  | { readonly status: "refused" }
>;

export type FinishStep = (
  input:
    | {
        readonly stepNo: number;
        readonly outcome: "done";
        readonly resultSha256: string;
        readonly resultBytes: number;
        readonly truncated: boolean;
      }
    | { readonly stepNo: number; readonly outcome: "failed" },
) => Promise<boolean>;

export type ToolLoopDeps = {
  /** The port call with the route's timeout; a throw is an abort. */
  readonly callPort: (input: AssistantPortInput) => Promise<AssistantPortOutcome>;
  readonly beginStep: BeginStep;
  readonly finishStep: FinishStep;
  /** The only outbound path; its destination list is empty in the pilot. */
  readonly guard: SearchGuard;
};

export type ToolLoopInput = {
  readonly instructions: string;
  readonly history: readonly DataPart[];
  readonly paragraph: string;
  readonly purposeKey: string;
  readonly modelId: string;
  /** The allowed set reserved with the request; empty: no loop. */
  readonly tools: readonly ToolName[];
};

export type ToolLoopResult =
  | { readonly kind: "success"; readonly text: string; readonly totalMicro: bigint }
  | {
      readonly kind: "tool_step_limit" | "request_revoked" | "response_too_large";
      readonly totalMicro: bigint;
    }
  /** The provider failed; null cost settles at the reservation. */
  | { readonly kind: "provider_error"; readonly totalMicro: bigint | null }
  /** Timeout, abort or a step the database refused: the outcome is unknown. */
  | { readonly kind: "unknown" };

const isToolName = (name: string): name is ToolName => name === "web_search";

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The run of one request; never throws for an expected outcome. */
export async function runToolLoop(
  deps: ToolLoopDeps,
  input: ToolLoopInput,
): Promise<ToolLoopResult> {
  let tools: readonly ToolName[] = input.tools;
  const toolParts: DataPart[] = [];
  const paragraph: DataPart = { kind: "paragraph", text: input.paragraph, truncated: false };
  let total = 0n;
  let nextStep = 1;
  for (;;) {
    const assembled = assembleDataParts({ history: input.history, paragraph, toolParts });
    if (!assembled.ok) return { kind: "unknown" };
    const outcome = await deps.callPort(
      buildPortInput({
        instructions: input.instructions,
        data: assembled.parts,
        tools,
        purposeKey: input.purposeKey,
        modelId: input.modelId,
      }),
    );
    if (outcome.kind === "timeout" || outcome.kind === "aborted") return { kind: "unknown" };
    if (outcome.kind === "provider_error") {
      return {
        kind: "provider_error",
        totalMicro: outcome.actualMicro === undefined ? null : total + outcome.actualMicro,
      };
    }
    total += outcome.actualMicro;
    if (outcome.kind === "success") {
      const checked = checkResponse(outcome.text);
      if (!checked.ok) return { kind: "response_too_large", totalMicro: total };
      if (checked.text.trim() === "") return { kind: "provider_error", totalMicro: total };
      return { kind: "success", text: checked.text, totalMicro: total };
    }
    // tool_calls: a request without a loop, or more calls than steps remain,
    // ends here, without running any of them and without another call.
    const planned = stepsOf(outcome.calls, nextStep, TOOL_STEP_MAX, sha256Hex);
    if (input.tools.length === 0 || planned.overLimit || planned.steps.length === 0) {
      return { kind: "tool_step_limit", totalMicro: total };
    }
    for (const step of planned.steps) {
      const begun = await deps.beginStep({
        stepNo: nextStep,
        toolName: step.toolName,
        requestedNameSha256: step.requestedNameSha256,
        argsSha256: step.argsSha256,
        argsValid: step.argsValid,
      });
      if (begun.status !== "ok") return { kind: "unknown" };
      const stepNo = nextStep;
      nextStep += 1;
      if (begun.outcome === "denied_revoked") return { kind: "request_revoked", totalMicro: total };
      tools = begun.tools.filter(isToolName);
      if (begun.outcome !== "allowed" || step.query === null) {
        toolParts.push({ kind: "tool_denied", text: begun.outcome, truncated: false });
        continue;
      }
      const destination = deps.guard.destinationIds[0];
      const result =
        destination === undefined
          ? ({ kind: "failed", rule: "unknown_destination" } as const)
          : await deps.guard.search(destination, step.query);
      if (result.kind === "result") {
        const part = toolResultPart(result.text);
        const finished = await deps.finishStep({
          stepNo,
          outcome: "done",
          resultSha256: sha256Hex(part.text),
          resultBytes: utf8ByteLength(part.text),
          truncated: part.truncated,
        });
        if (!finished) return { kind: "unknown" };
        toolParts.push(part);
      } else {
        if (!(await deps.finishStep({ stepNo, outcome: "failed" }))) return { kind: "unknown" };
        toolParts.push({ kind: "tool_denied", text: "failed", truncated: false });
      }
    }
  }
}

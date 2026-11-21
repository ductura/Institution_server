/**
 * One tool request of the model as the route records it (Ductus
 * docs/contracts/ai-tools-v1.md, "Izračun i provjera po koraku", "Granice
 * izlaza" and `assistant.tool_step`; plan #1664 S3-D3, S3-D4, S3-I2, S3-I4).
 *
 * Pure: from the structured `tool_calls` field of the port output only, never
 * from answer text. The name maps byte for byte to a code tool or to null,
 * the arguments are checked against the closed schema before anything runs,
 * and neither the name nor the arguments are kept: only SHA-256 of their
 * exact bytes. A name outside the code set may carry part of the paragraph,
 * so it is never stored as text (contract, `assistant.tool_step`). The hash
 * function comes from the caller, so this module imports no package.
 */
import type { PortToolCall } from "./port.ts";
import { matchToolName, validateToolArgs, type ToolName } from "./tools.ts";

export type PlannedToolCall = {
  /** The code tool, or null when the requested name is not exactly one. */
  readonly toolName: ToolName | null;
  readonly requestedNameSha256: string;
  readonly argsSha256: string;
  /** The closed-schema check; false for every unknown tool. */
  readonly argsValid: boolean;
  /** The checked arguments, only when valid; never stored. */
  readonly query: string | null;
};

/** SHA-256 of the UTF-8 bytes of a text, lower-case hex; the caller supplies it. */
export type Sha256Hex = (text: string) => string;

/**
 * Canonical bytes of untrusted arguments for their hash: JSON with standard
 * escaping, or the marker of a value JSON cannot hold.
 */
function argsBytes(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "undefined";
  } catch {
    return "unserialisable";
  }
}

/** The record of one requested call, before `begin_tool_step`. */
export function planToolCall(call: PortToolCall, sha256Hex: Sha256Hex): PlannedToolCall {
  const name: unknown = (call as { name?: unknown }).name;
  const nameText = typeof name === "string" ? name : argsBytes(name);
  const toolName = matchToolName(name);
  const checked = toolName === null ? null : validateToolArgs(toolName, call.args);
  return Object.freeze({
    toolName,
    requestedNameSha256: sha256Hex(nameText),
    argsSha256: sha256Hex(argsBytes(call.args)),
    argsValid: checked?.ok === true,
    query: checked?.ok === true ? checked.args.query : null,
  });
}

/**
 * The calls of one port output split into steps: one call is one step, also
 * when one output asks for several (S3-I2). `nextStep` is the number the
 * first of them takes; steps past `stepMax` are not planned and the request
 * ends with `tool_step_limit`.
 */
export function stepsOf(
  calls: readonly PortToolCall[],
  nextStep: number,
  stepMax: number,
  sha256Hex: Sha256Hex,
): { readonly steps: readonly PlannedToolCall[]; readonly overLimit: boolean } {
  const room = Math.max(0, stepMax - nextStep + 1);
  return {
    steps: calls.slice(0, room).map((call) => planToolCall(call, sha256Hex)),
    overLimit: calls.length > room,
  };
}

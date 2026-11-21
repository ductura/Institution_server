/**
 * The port to an AI provider, version 2 of its input (Ductus
 * docs/contracts/ai-request-v1.md, "Port i sintetički adapter", and
 * docs/contracts/ai-tools-v1.md, "Port i sintetički adapter"; plan #1662 S3,
 * G8, G9 and #1664 S3-O1, S3-D2, S3-I3, S3-I4).
 *
 * The input carries only what the provider may see: the server's
 * instructions for the purpose, the untrusted data as separate parts whose
 * kind the server sets, the tools of the allowed set with their closed
 * schemas, the purpose key, the model and the largest answer in bytes. There
 * is no field for a user, a work, an institution or anything about the
 * writing process, and `buildPortInput` builds exactly these six keys. Data
 * never joins the instructions in one string (S3-O1).
 *
 * The output has a `tool_calls` branch: a tool request counts only from
 * that structured field, never from the text of an answer (S3-I4).
 *
 * Amounts are whole micro-euros as `bigint` (1 EUR = 1 000 000), never a
 * floating-point number.
 */
import { hasOnlyKeys, isPlainObject } from "../json/index.ts";
import { DATA_PART_KINDS, RESPONSE_MAX_BYTES, type DataPart } from "./instructions.ts";
import { CODE_TOOLS, toolSchema, type ToolName, type ToolSchema } from "./tools.ts";

export const ASSISTANT_PORT_INPUT_KEYS = Object.freeze([
  "data",
  "instructions",
  "maxResponseBytes",
  "modelId",
  "purposeKey",
  "tools",
] as const);

/** `modelId` shape of `ductus-ai-transfer-v1` (evidence-segment-v4). */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** `providerId` shape of `ductus-ai-transfer-v1` (evidence-segment-v4). */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** A tool offered to the provider: a member of the allowed set and its schema. */
export type PortTool = { readonly name: ToolName; readonly schema: ToolSchema };

export type AssistantPortInput = {
  readonly instructions: string;
  readonly data: readonly DataPart[];
  readonly tools: readonly PortTool[];
  readonly purposeKey: string;
  readonly modelId: string;
  readonly maxResponseBytes: number;
};

/** One tool request of the model: the name as asked, the arguments unchecked. */
export type PortToolCall = { readonly name: string; readonly args: unknown };

export type AssistantPortOutcome =
  | { readonly kind: "success"; readonly text: string; readonly actualMicro: bigint }
  | {
      readonly kind: "tool_calls";
      readonly calls: readonly PortToolCall[];
      readonly actualMicro: bigint;
    }
  | { readonly kind: "provider_error"; readonly actualMicro?: bigint }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export type AssistantPort = {
  /** Called only for a request in state `sent`, after the commit (R2). */
  complete(input: AssistantPortInput): Promise<AssistantPortOutcome>;
};

export type PortInputParts = {
  readonly instructions: string;
  readonly data: readonly DataPart[];
  readonly tools: readonly ToolName[];
  readonly purposeKey: string;
  readonly modelId: string;
  readonly maxResponseBytes?: number;
};

/**
 * The tools of an allowed set as the port offers them, in code order, each
 * with its closed schema. An empty set offers no tool at all (S3-D2).
 */
export function offerTools(allowed: readonly string[]): readonly PortTool[] {
  return CODE_TOOLS.filter((name) => allowed.includes(name)).map((name) =>
    Object.freeze({ name, schema: toolSchema(name) }),
  );
}

/**
 * The port input from exactly these parts. A caller holding a wider object
 * (a request row, a session) still passes only these six fields: nothing
 * else is copied, and every data part is copied key by key.
 */
export function buildPortInput(parts: PortInputParts): AssistantPortInput {
  return {
    instructions: parts.instructions,
    data: parts.data.map((part) => ({
      kind: part.kind,
      text: part.text,
      truncated: part.truncated,
    })),
    tools: offerTools(parts.tools),
    purposeKey: parts.purposeKey,
    modelId: parts.modelId,
    maxResponseBytes: parts.maxResponseBytes ?? RESPONSE_MAX_BYTES,
  };
}

function isDataPartValue(value: unknown): boolean {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(["kind", "text", "truncated"])))
    return false;
  return (
    typeof value["kind"] === "string" &&
    (DATA_PART_KINDS as readonly string[]).includes(value["kind"]) &&
    typeof value["text"] === "string" &&
    typeof value["truncated"] === "boolean"
  );
}

function isPortToolValue(value: unknown): boolean {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(["name", "schema"]))) return false;
  const name = value["name"];
  return (
    typeof name === "string" &&
    (CODE_TOOLS as readonly string[]).includes(name) &&
    value["schema"] === toolSchema(name as ToolName)
  );
}

/** True for a port input with exactly the six keys and the right types. */
export function isAssistantPortInput(value: unknown): value is AssistantPortInput {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(ASSISTANT_PORT_INPUT_KEYS)))
    return false;
  const { instructions, data, tools, purposeKey, modelId, maxResponseBytes } = value;
  return (
    typeof instructions === "string" &&
    Array.isArray(data) &&
    data.length > 0 &&
    (data as unknown[]).every(isDataPartValue) &&
    Array.isArray(tools) &&
    (tools as unknown[]).every(isPortToolValue) &&
    new Set((tools as { name: string }[]).map((tool) => tool.name)).size === tools.length &&
    typeof purposeKey === "string" &&
    typeof modelId === "string" &&
    MODEL_ID_PATTERN.test(modelId) &&
    Number.isSafeInteger(maxResponseBytes) &&
    (maxResponseBytes as number) > 0 &&
    (maxResponseBytes as number) <= RESPONSE_MAX_BYTES
  );
}

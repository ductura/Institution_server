/**
 * The port to an AI provider (Ductus docs/contracts/ai-request-v1.md, "Port i
 * sintetički adapter"; plan #1662 S3, G8, G9).
 *
 * The input carries only what the provider may see: the server's
 * instructions for the purpose, the student's paragraph inside a fence,
 * the purpose key, the model and the longest answer. There is no field for a
 * user, a work, an institution or anything about the writing process, and
 * `buildPortInput` builds exactly these five keys. There is no field for a
 * tool either: tools wait for #1664.
 *
 * Amounts are whole micro-euros as `bigint` (1 EUR = 1 000 000), never a
 * floating-point number.
 */
import { hasOnlyKeys, isPlainObject } from "../json/index.ts";

export const ASSISTANT_PORT_INPUT_KEYS = Object.freeze([
  "instructions",
  "maxResponseCodePoints",
  "modelId",
  "paragraph",
  "purposeKey",
] as const);

/** `modelId` shape of `ductus-ai-transfer-v1` (evidence-segment-v4). */
export const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
/** `providerId` shape of `ductus-ai-transfer-v1` (evidence-segment-v4). */
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The paragraph as data: fenced so no text inside can close the fence. */
export type FencedParagraph = { readonly fence: string; readonly text: string };

export type AssistantPortInput = {
  readonly instructions: string;
  readonly paragraph: FencedParagraph;
  readonly purposeKey: string;
  readonly modelId: string;
  readonly maxResponseCodePoints: number;
};

export type AssistantPortOutcome =
  | { readonly kind: "success"; readonly text: string; readonly actualMicro: bigint }
  | { readonly kind: "provider_error"; readonly actualMicro?: bigint }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" };

export type AssistantPort = {
  /** Called only for a request in state `sent`, after the commit (R2). */
  complete(input: AssistantPortInput): Promise<AssistantPortOutcome>;
};

/**
 * A backtick fence longer than any run of backticks in the paragraph, so the
 * paragraph cannot end the fence and pass for server instructions (Z11).
 */
export function fenceParagraph(paragraph: string): FencedParagraph {
  const longest = Math.max(0, ...[...paragraph.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return { fence, text: `${fence}text\n${paragraph}\n${fence}` };
}

export type PortInputParts = {
  readonly instructions: string;
  readonly paragraph: string;
  readonly purposeKey: string;
  readonly modelId: string;
  readonly maxResponseCodePoints: number;
};

/**
 * The port input from exactly these parts. A caller holding a wider object
 * (a request row, a session) still passes only these five fields: nothing
 * else is copied.
 */
export function buildPortInput(parts: PortInputParts): AssistantPortInput {
  return {
    instructions: parts.instructions,
    paragraph: fenceParagraph(parts.paragraph),
    purposeKey: parts.purposeKey,
    modelId: parts.modelId,
    maxResponseCodePoints: parts.maxResponseCodePoints,
  };
}

/** True for a port input with exactly the five keys and the right types. */
export function isAssistantPortInput(value: unknown): value is AssistantPortInput {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(ASSISTANT_PORT_INPUT_KEYS)))
    return false;
  const { instructions, paragraph, purposeKey, modelId, maxResponseCodePoints } = value;
  return (
    typeof instructions === "string" &&
    isPlainObject(paragraph) &&
    hasOnlyKeys(paragraph, new Set(["fence", "text"])) &&
    typeof paragraph["fence"] === "string" &&
    typeof paragraph["text"] === "string" &&
    typeof purposeKey === "string" &&
    typeof modelId === "string" &&
    MODEL_ID_PATTERN.test(modelId) &&
    Number.isSafeInteger(maxResponseCodePoints) &&
    (maxResponseCodePoints as number) > 0
  );
}

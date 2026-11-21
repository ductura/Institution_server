/**
 * The closed tool set of the assistant (Ductus docs/contracts/ai-tools-v1.md,
 * C-37, "Prekidač ustanove", "Dopušteni skup alata" and "Granice izlaza";
 * plan #1664 S3-D1 to S3-D4, S3-D6, S3-N2).
 *
 * The code knows one tool, `web_search`, with a closed argument schema. The
 * tools offered for a step are the intersection of the code set, the
 * institution switch, the tools the teacher turned on for the assignment and
 * the tools that are ready (search: a non-empty destination list). A name the
 * model asks for matches only byte for byte.
 *
 * The institution switch and the search destinations live in the versioned
 * faculty setting `config/faculties/<faculty>.json` (owner decisions OC-1
 * and OC-2 of 21. 11. 2026., `faculty-ai-config.ts`), read through the server
 * layer; every flag is off and every destination list is empty, so in
 * production no tool is ever offered. Nothing here changes the switch; a test
 * composition builds its own reader from a synthetic source.
 */
import { hasOnlyKeys, isPlainObject, ownProperty } from "../json/index.ts";

export const CODE_TOOLS = Object.freeze(["web_search"] as const);
export type ToolName = (typeof CODE_TOOLS)[number];

/** Longest `web_search` query, in code points after NFC (S3-N2). */
export const QUERY_MAX = 256;

/** A closed JSON Schema of a tool's arguments, as the port offers it (S3-D4). */
export type ToolSchema = {
  readonly type: "object";
  readonly additionalProperties: false;
  readonly required: readonly string[];
  readonly properties: Readonly<
    Record<
      string,
      { readonly type: "string"; readonly minLength: number; readonly maxLength: number }
    >
  >;
};

/** The schema of `web_search`; `validateToolArgs` enforces the same shape. */
export const WEB_SEARCH_SCHEMA: ToolSchema = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["query"]),
  properties: Object.freeze({
    query: Object.freeze({ type: "string", minLength: 1, maxLength: QUERY_MAX }),
  }),
});

/** The closed schema of a code tool. */
export function toolSchema(name: ToolName): ToolSchema {
  switch (name) {
    case "web_search":
      return WEB_SEARCH_SCHEMA;
  }
}

/** The outcomes of a tool step row (contract, `assistant.tool_step`). */
export const TOOL_STEP_OUTCOMES = Object.freeze([
  "allowed",
  "denied_not_in_set",
  "denied_schema",
  "denied_revoked",
  "failed",
  "done",
] as const);
export type ToolStepOutcome = (typeof TOOL_STEP_OUTCOMES)[number];

/**
 * The code tool with exactly this name, or null. No case folding, trimming
 * or Unicode normalisation (S3-D3).
 */
export function matchToolName(requested: unknown): ToolName | null {
  if (typeof requested !== "string") return null;
  return CODE_TOOLS.find((name) => name === requested) ?? null;
}

export type ToolArgsRule =
  | "args_not_object"
  | "args_unknown_key"
  | "args_missing_key"
  | "query_not_string"
  | "query_empty"
  | "query_too_long";

export type ToolArgsResult =
  | { readonly ok: true; readonly args: { readonly query: string } }
  | { readonly ok: false; readonly outcome: "denied_schema"; readonly rule: ToolArgsRule };

function deny(rule: ToolArgsRule): ToolArgsResult {
  return { ok: false, outcome: "denied_schema", rule };
}

/**
 * The arguments of a `web_search` call against its closed schema: exactly
 * the key `query`, a string of 1 to QUERY_MAX code points after NFC (S3-D4).
 * A query that looks like an address is only query text (S3-N2).
 */
export function validateToolArgs(tool: ToolName, args: unknown): ToolArgsResult {
  if (tool !== "web_search" || !isPlainObject(args)) return deny("args_not_object");
  if (!hasOnlyKeys(args, new Set(["query"]))) return deny("args_unknown_key");
  if (!Object.prototype.hasOwnProperty.call(args, "query")) return deny("args_missing_key");
  const query = ownProperty(args, "query");
  if (typeof query !== "string") return deny("query_not_string");
  const text = query.normalize("NFC");
  const length = [...text].length;
  if (length === 0) return deny("query_empty");
  if (length > QUERY_MAX) return deny("query_too_long");
  return { ok: true, args: { query: text } };
}

export type InstitutionAiSwitch = {
  readonly transcription: boolean;
  readonly tools: boolean;
};

/** A source of the switch, for a test composition only. */
export type AiSwitchSource = (institutionId: string) => unknown;

const SWITCH_OFF: InstitutionAiSwitch = Object.freeze({ transcription: false, tools: false });

/** A reader over a source: a flag is on only when it is exactly `true`. */
export function makeAiSwitchReader(
  source: AiSwitchSource,
): (institutionId: string) => InstitutionAiSwitch {
  return (institutionId) => {
    const value = source(institutionId);
    if (!isPlainObject(value)) return SWITCH_OFF;
    return Object.freeze({
      transcription: ownProperty(value, "transcription") === true,
      tools: ownProperty(value, "tools") === true,
    });
  };
}

/** Both flags off: the switch of every institution without a valid setting. */
export const AI_SWITCH_OFF: InstitutionAiSwitch = SWITCH_OFF;

/** The code tools ready to run: search needs at least one destination. */
export function readyTools(searchDestinations: readonly unknown[]): readonly ToolName[] {
  return searchDestinations.length > 0 ? ["web_search"] : [];
}

/**
 * The tools a step may offer: CODE_TOOLS ∩ switch.tools ∩ assignment tools
 * ∩ ready, in code order (S3-D1). Names compare byte for byte.
 */
export function allowedTools(input: {
  readonly institutionSwitch: InstitutionAiSwitch;
  readonly assignmentTools: readonly string[];
  readonly ready: readonly string[];
}): readonly ToolName[] {
  if (input.institutionSwitch.tools !== true) return [];
  return CODE_TOOLS.filter(
    (name) => input.assignmentTools.includes(name) && input.ready.includes(name),
  );
}

export type AssignmentToolsResult =
  | { readonly ok: true; readonly tools: readonly ToolName[] }
  | { readonly ok: false; readonly outcome: "invalid_request" };

/**
 * A teacher's tool list for `set_assignment_tools`: an array of distinct
 * names from the code set, or `invalid_request`.
 */
export function parseAssignmentTools(value: unknown): AssignmentToolsResult {
  if (!Array.isArray(value)) return { ok: false, outcome: "invalid_request" };
  const tools: ToolName[] = [];
  for (const item of value as unknown[]) {
    const name = matchToolName(item);
    if (name === null || tools.includes(name)) return { ok: false, outcome: "invalid_request" };
    tools.push(name);
  }
  return { ok: true, tools };
}

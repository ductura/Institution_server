/**
 * The OpenAI adapter of the assistant port (F4-PM2-R11; owner decision of
 * 26. 11. 2026, D-316: provider OpenAI, the organisation account of Ductura).
 *
 * It speaks the Responses API through a transport handed in, so this file
 * opens no connection of its own and reads no environment: the composition
 * (server/http/assistant/openai-provider.ts) supplies the key, the model, the
 * prices and the transport. No model name and no amount lives here (Q-10, T8).
 *
 * What goes to the provider is only what the port input holds (G8, G9): the
 * server instructions, the untrusted data as one fenced JSON text, the closed
 * tool schemas and the model. `store: false` keeps the response out of the
 * provider's stored conversation state, but it is not "nothing is kept": the
 * provider keeps abuse monitoring logs of the request for up to 30 days,
 * unless zero data retention (ZDR) is approved for the account. Whether that
 * is acceptable is the DPIA (ductura/.github docs/pravo/DPIA-OPENAI.md) and
 * the DPO's call, not this file's. What the adapter reports out is metadata
 * only: model, status, token counts and duration, never a text, a key or a
 * header.
 *
 * The base address is one of a closed list (AI-EU-ADRESA): the European
 * project's address by default (DPIA-OPENAI, EVIDENCIJA-OBRADA), the US one
 * only when OPENAI_BASE_URL names it exactly. Any other value refuses the
 * start (openAiBaseUrlProblems), never a quiet fall back to the US.
 */
import {
  type AssistantPort,
  type AssistantPortInput,
  type AssistantPortOutcome,
  encodeDataParts,
  isAssistantPortInput,
  type PortToolCall,
} from "../../domain/index.ts";

/** The European project's address (EEA and Switzerland); the default. */
export const OPENAI_EU_BASE_URL = "https://eu.api.openai.com/v1";
/** The provider's US address; used only when OPENAI_BASE_URL names it exactly. */
export const OPENAI_US_BASE_URL = "https://api.openai.com/v1";
/** The closed list of base addresses; this file is the one place they are named. */
export const OPENAI_BASE_URLS: readonly string[] = Object.freeze([
  OPENAI_EU_BASE_URL,
  OPENAI_US_BASE_URL,
]);
/** The default base address: Europe, never the US by accident. */
export const OPENAI_BASE_URL = OPENAI_EU_BASE_URL;
/** The environment variable that may choose another address from the list. */
export const OPENAI_BASE_URL_VARIABLE = "OPENAI_BASE_URL";

/** The environment handed in by the composition; this file never reads the process's own. */
export type OpenAiBaseUrlEnv = Readonly<Record<string, string | undefined>>;

/**
 * The base address chosen by the environment: the default (Europe) when the
 * variable is unset, the value when it is exactly one of the list, else null.
 * An empty value, another host, another scheme, a trailing slash or spaces
 * are all null: the start is refused, nothing falls back to the US.
 */
export function openAiBaseUrlOf(env: OpenAiBaseUrlEnv): string | null {
  const value = Object.hasOwn(env, OPENAI_BASE_URL_VARIABLE)
    ? env[OPENAI_BASE_URL_VARIABLE]
    : undefined;
  if (value === undefined) return OPENAI_BASE_URL;
  return OPENAI_BASE_URLS.includes(value) ? value : null;
}

/** Startup problems (server.ts): one line naming the variable, never its value. */
export function openAiBaseUrlProblems(env: OpenAiBaseUrlEnv): string[] {
  return openAiBaseUrlOf(env) === null
    ? [`${OPENAI_BASE_URL_VARIABLE} is not one of the allowed OpenAI addresses`]
    : [];
}

const TOKEN_UNIT = 1_000_000;

/** The request as the transport sends it; the key is added by the adapter as a header. */
export type OpenAiTransportRequest = {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal: AbortSignal;
};
export type OpenAiTransportResponse = {
  readonly status: number;
  readonly json: () => Promise<unknown>;
};
export type OpenAiTransport = (request: OpenAiTransportRequest) => Promise<OpenAiTransportResponse>;

/** Metadata of one call; no text, no key, no identity. */
export type OpenAiCallMetadata = {
  readonly model: string;
  readonly outcome: AssistantPortOutcome["kind"];
  readonly httpStatus: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly durationMs: number;
};

export type OpenAiAssistantDeps = {
  readonly apiKey: string;
  readonly transport: OpenAiTransport;
  /** Whole units of the account currency per million tokens, as bigint micro-units. */
  readonly rates: { readonly input: bigint; readonly output: bigint };
  /** One of OPENAI_BASE_URLS; the default is Europe. Any other value is a programming error. */
  readonly baseUrl?: string;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly record?: (metadata: OpenAiCallMetadata) => void;
};

type Usage = { readonly input: number; readonly output: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function usageOf(body: Record<string, unknown>): Usage | null {
  const usage = body["usage"];
  if (!isRecord(usage)) return null;
  const input = tokenCount(usage["input_tokens"]);
  const output = tokenCount(usage["output_tokens"]);
  return input === null || output === null ? null : { input, output };
}

/** Cost in micro-units, rounded up so the account never under-reports. */
export function costOf(usage: Usage, rates: OpenAiAssistantDeps["rates"]): bigint {
  const unit = BigInt(TOKEN_UNIT);
  const total = BigInt(usage.input) * rates.input + BigInt(usage.output) * rates.output;
  return (total + unit - BigInt(1)) / unit;
}

function requestBody(input: AssistantPortInput): string {
  return JSON.stringify({
    model: input.modelId,
    instructions: input.instructions,
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: encodeDataParts(input.data) }],
      },
    ],
    tools: input.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.name,
      parameters: tool.schema,
      strict: false,
    })),
    ["max_output_tokens"]: input.maxResponseBytes,
    store: false,
  });
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    // Kept as the raw string; the tool validator refuses it (S3-I4).
    return raw;
  }
}

/** The outcome of a 2xx body: tool calls only from the structured items, never from text. */
function outcomeOfBody(body: unknown, rates: OpenAiAssistantDeps["rates"]): AssistantPortOutcome {
  if (!isRecord(body)) return { kind: "provider_error" };
  const usage = usageOf(body);
  const actualMicro = usage === null ? undefined : costOf(usage, rates);
  const failed = (): AssistantPortOutcome =>
    actualMicro === undefined
      ? { kind: "provider_error" }
      : { kind: "provider_error", actualMicro };
  if (body["status"] !== "completed" || actualMicro === undefined) return failed();
  const items = body["output"];
  if (!Array.isArray(items)) return failed();
  const calls: PortToolCall[] = [];
  let text = "";
  for (const item of items as unknown[]) {
    if (!isRecord(item)) return failed();
    if (item["type"] === "function_call") {
      if (typeof item["name"] !== "string") return failed();
      calls.push({ name: item["name"], args: parseArgs(item["arguments"]) });
    } else if (item["type"] === "message") {
      const content = item["content"];
      if (!Array.isArray(content)) return failed();
      for (const part of content as unknown[]) {
        if (!isRecord(part)) return failed();
        if (part["type"] === "refusal") return failed();
        if (part["type"] === "output_text" && typeof part["text"] === "string")
          text += part["text"];
      }
    }
  }
  if (calls.length > 0) return { kind: "tool_calls", calls, actualMicro };
  if (text === "") return failed();
  return { kind: "success", text, actualMicro };
}

/**
 * The adapter. An input that is not exactly a port input, or a base address
 * outside the closed list, is a programming error.
 */
export function createOpenAiAssistant(deps: OpenAiAssistantDeps): AssistantPort {
  const now = deps.now ?? Date.now;
  const base = deps.baseUrl ?? OPENAI_BASE_URL;
  if (!OPENAI_BASE_URLS.includes(base)) throw new TypeError("not an allowed OpenAI base address");
  return Object.freeze({
    async complete(input: AssistantPortInput): Promise<AssistantPortOutcome> {
      if (!isAssistantPortInput(input)) throw new TypeError("not an assistant port input");
      const started = now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
      let httpStatus: number | null = null;
      let usage: Usage | null = null;
      let outcome: AssistantPortOutcome;
      try {
        const response = await deps.transport({
          url: `${base}/responses`,
          headers: {
            authorization: `Bearer ${deps.apiKey}`,
            "content-type": "application/json",
          },
          body: requestBody(input),
          signal: controller.signal,
        });
        httpStatus = response.status;
        if (response.status < 200 || response.status > 299) {
          outcome = { kind: "provider_error" };
        } else {
          const body = await response.json();
          if (isRecord(body)) usage = usageOf(body);
          outcome = outcomeOfBody(body, deps.rates);
        }
      } catch {
        // Aborted by our timer: no answer in time. Any other failure: the call
        // may or may not have reached the provider, so it is an abort.
        outcome = controller.signal.aborted ? { kind: "timeout" } : { kind: "aborted" };
      } finally {
        clearTimeout(timer);
      }
      try {
        deps.record?.({
          model: input.modelId,
          outcome: outcome.kind,
          httpStatus,
          inputTokens: usage?.input ?? null,
          outputTokens: usage?.output ?? null,
          durationMs: now() - started,
        });
      } catch {
        // A failing recorder never changes the outcome.
      }
      return outcome;
    },
  });
}

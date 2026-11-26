// Composition of the OpenAI provider of the assistant proxy (F4-PM2-R11,
// D-316). The key, the model and the prices come from the environment handed
// in; without a key or without both prices the result is null and the route
// answers ai_disabled. The model is never in code: AI_MODEL, with the default
// below (the smallest current general GPT model of the official OpenAI
// documentation when this was written). The key is never logged.
import {
  createOpenAiAssistant,
  type OpenAiCallMetadata,
  type OpenAiTransport,
} from "../../external/assistant/index.ts";

import { parseAssistantProviderConfig, type AssistantProviderConfig } from "./config.ts";

import type { AssistantProvider } from "./index.ts";

/** Default of AI_MODEL; changing it is a configuration change, not a code change. */
export const DEFAULT_AI_MODEL = "gpt-6-luna";
export const DEFAULT_AI_CONFIG_VERSION = "openai-v1";
export const OPENAI_TIMEOUT_MS = 55_000;

const DIGITS = /^[0-9]{1,15}$/u;

function rateOf(value: string | undefined): bigint | null {
  if (value === undefined || !DIGITS.test(value)) return null;
  const rate = BigInt(value);
  return rate > 0n ? rate : null;
}

/** The environment handed in; only the keys named below are read. */
export type OpenAiEnv = Readonly<Record<string, string | undefined>>;

export type OpenAiProviderOptions = {
  readonly transport?: OpenAiTransport;
  /** Receives metadata only (model, outcome, tokens, duration). */
  readonly record?: (metadata: OpenAiCallMetadata) => void;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
};

const fetchTransport: OpenAiTransport = (request) =>
  fetch(request.url, {
    method: "POST",
    headers: { ...request.headers },
    body: request.body,
    signal: request.signal,
  });

/** The provider, or null (ai_disabled) when the key, the prices or the entry are missing or refused. */
export function openAiProviderFrom(
  env: OpenAiEnv,
  options: OpenAiProviderOptions = {},
): AssistantProvider | null {
  const apiKey = env["OPENAI_API_KEY"];
  const input = rateOf(env["AI_RATE_INPUT_MICRO_PER_MTOK"]);
  const output = rateOf(env["AI_RATE_OUTPUT_MICRO_PER_MTOK"]);
  if (apiKey === undefined || apiKey.trim() === "" || input === null || output === null)
    return null;
  const parsed = parseAssistantProviderConfig({
    configVersion: env["AI_CONFIG_VERSION"] ?? DEFAULT_AI_CONFIG_VERSION,
    provider: {
      providerId: "openai",
      modelId: env["AI_MODEL"] ?? DEFAULT_AI_MODEL,
      headquarters: "US",
      modelDeveloperHeadquarters: "US",
      processingCountries: ["US"],
    },
  });
  if (!parsed.ok) return null;
  const config: AssistantProviderConfig = parsed.config;
  const port = createOpenAiAssistant({
    apiKey,
    transport: options.transport ?? fetchTransport,
    rates: { input, output },
    timeoutMs: options.timeoutMs ?? OPENAI_TIMEOUT_MS,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.record === undefined ? {} : { record: options.record }),
  });
  return { config, port };
}

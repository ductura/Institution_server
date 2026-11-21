/**
 * The gated provider port (SRV-1809, plan M9.0-S2; D-267 O1, O5; Ductus
 * docs/contracts/ai-request-v1.md, P1).
 *
 * It sits in front of the one adapter that exists, the synthetic one, and
 * answers `ai_disabled` without calling it unless all three hold: the
 * institution setting is on, the cost configuration has every limit set, and
 * an adapter was composed. An empty cost configuration means the assistant is
 * off. No real provider, no amount and no account model is chosen here
 * (Q-10): every amount comes from the configuration handed in, and the
 * production composition hands in none, so it always answers `ai_disabled`.
 */
import {
  type AssistantPort,
  type AssistantPortInput,
  type AssistantPortOutcome,
} from "../../domain/index.ts";

import {
  PRODUCTION_ASSISTANT_SETTING,
  readAssistantSetting,
  type AssistantInstitutionSetting,
} from "./institution-setting.ts";

/** The limits of the cost configuration (server/database/assistant, CostConfigInput). */
export const COST_LIMIT_KEYS = Object.freeze([
  "studentDayMicro",
  "studentAssignmentDayMicro",
  "reserveMicro",
] as const);

/**
 * True only for a plain object with exactly the three limits, each a bigint
 * of micro-euros above zero. Empty, partial, null or any other shape is off
 * (P1): the code never fills in a limit of its own.
 */
export function isCostConfigured(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;
  const keys = Object.keys(value);
  if (keys.length !== COST_LIMIT_KEYS.length) return false;
  return COST_LIMIT_KEYS.every((key) => {
    if (!Object.hasOwn(value, key)) return false;
    const limit = (value as Record<string, unknown>)[key];
    return typeof limit === "bigint" && limit > 0n;
  });
}

/** Why the port is off; for the server log, never for the student. */
export const AI_DISABLED_RULES = Object.freeze([
  "setting_off",
  "cost_config_empty",
  "no_adapter",
] as const);
export type AiDisabledRule = (typeof AI_DISABLED_RULES)[number];

export type AssistantProviderOutcome =
  AssistantPortOutcome | { readonly kind: "ai_disabled"; readonly rule: AiDisabledRule };

export type AssistantProviderPort = {
  /** The setting the port was composed with, after reading. */
  readonly setting: AssistantInstitutionSetting;
  complete(input: AssistantPortInput): Promise<AssistantProviderOutcome>;
};

export type AssistantProviderPortDeps = {
  /** The institution setting as configured; read strictly (`readAssistantSetting`). */
  readonly setting: unknown;
  /** The published cost configuration, or null when there is none. */
  readonly costConfig: unknown;
  /** The adapter; only the synthetic one exists, and only tests compose it. */
  readonly adapter: AssistantPort | null;
};

function disabled(rule: AiDisabledRule): AssistantProviderOutcome {
  return Object.freeze({ kind: "ai_disabled", rule });
}

/**
 * The port for one institution. The order of the checks is fixed: setting,
 * cost configuration, adapter. When one fails the adapter is never called.
 */
export function createAssistantProviderPort(
  deps: AssistantProviderPortDeps,
): AssistantProviderPort {
  const setting = readAssistantSetting(deps.setting);
  const rule: AiDisabledRule | null = !setting.enabled
    ? "setting_off"
    : !isCostConfigured(deps.costConfig)
      ? "cost_config_empty"
      : deps.adapter === null
        ? "no_adapter"
        : null;
  const adapter = deps.adapter;
  return Object.freeze({
    setting,
    complete(input: AssistantPortInput): Promise<AssistantProviderOutcome> {
      if (rule !== null || adapter === null) {
        return Promise.resolve(disabled(rule ?? "no_adapter"));
      }
      return adapter.complete(input);
    },
  });
}

/** The production port: setting off, no cost configuration, no adapter. */
export function createProductionAssistantProviderPort(): AssistantProviderPort {
  return createAssistantProviderPort({
    setting: PRODUCTION_ASSISTANT_SETTING,
    costConfig: null,
    adapter: null,
  });
}

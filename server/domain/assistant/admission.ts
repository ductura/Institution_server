/**
 * What the route checks before `assistant.begin_request` (Ductus
 * docs/contracts/ai-request-v1.md, "Stanja", phase "primljen"; plan #1662 Z1
 * to Z13, P1, R2).
 *
 * Order: the body and the key (`parseAssistantRequest`), then an empty or
 * partial cost configuration (`ai_disabled`, P1), then the effective policy
 * (`decidePolicy`). Only an admitted request may reach `begin_request`, which
 * repeats ownership, policy and limits inside its transaction (step 3): a
 * foreign or closed assignment or conversation (Z8, Z12) is decided there
 * with one `forbidden` for foreign and missing alike, and the budget too.
 */
import { decidePolicy, type PolicyInput, type PolicyRule } from "./policy.ts";
import type { PurposeEntry } from "./purpose-catalog.ts";
import { parseAssistantRequest, type AssistantRequest, type RequestRule } from "./request.ts";

/** The closed set of outcome codes a route returns (contract, "Ishodi"). */
export const ASSISTANT_OUTCOMES = Object.freeze([
  "invalid_request",
  "invalid_idempotency_key",
  "idempotency_conflict",
  "forbidden",
  "ai_disabled",
  "purpose_not_allowed",
  "budget_exceeded",
  "in_progress",
  "request_outcome_unknown",
  "provider_failed",
  "completed",
] as const);
export type AssistantOutcome = (typeof ASSISTANT_OUTCOMES)[number];

export type AdmissionContext = {
  /** The policy facts of the assignment version in force; the request adds its own. */
  readonly policy: Omit<PolicyInput, "request">;
  /**
   * True only when the service and the institution each have a published
   * cost configuration with every limit set. Anything less is off (P1).
   */
  readonly costConfigured: boolean;
};

export type AdmissionRule = RequestRule | PolicyRule | "cost_config_missing";

export type Admission =
  | { readonly ok: true; readonly request: AssistantRequest; readonly purpose: PurposeEntry }
  | { readonly ok: false; readonly outcome: AssistantOutcome; readonly rule: AdmissionRule };

export function admitAssistantRequest(
  input: { readonly body: Uint8Array; readonly idempotencyKey: string | null | undefined },
  context: AdmissionContext,
): Admission {
  const parsed = parseAssistantRequest(input);
  if (!parsed.ok) return { ok: false, outcome: parsed.outcome, rule: parsed.rule };
  if (context.costConfigured !== true) {
    return { ok: false, outcome: "ai_disabled", rule: "cost_config_missing" };
  }
  const { request } = parsed;
  const decision = decidePolicy({
    ...context.policy,
    request: {
      purposeCatalogVersion: request.purposeCatalogVersion,
      purposeKey: request.purposeKey,
    },
  });
  if (!decision.ok) return { ok: false, outcome: decision.outcome, rule: decision.rule };
  return { ok: true, request, purpose: decision.purpose };
}

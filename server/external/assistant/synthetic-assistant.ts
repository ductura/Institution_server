/**
 * The synthetic assistant adapter (Ductus docs/contracts/ai-request-v1.md,
 * "Port i sintetički adapter"; plan #1662 S1, S2, M9).
 *
 * It opens no network connection and needs no secret: it imports nothing but
 * the port types. It returns each branch of S2 deterministically, from a
 * script the caller hands in: success, provider error, timeout, abort after
 * sending, a late answer and a cost above the reservation. Tool branches wait
 * for #1664; the real adapter waits for M9.1 (OA-1, OA-8).
 *
 * No amount lives here: every cost comes from the script (T8). Every call is
 * recorded exactly as the port received it, so a test can show what would
 * have gone to a provider (G8).
 */
import {
  type AssistantPort,
  type AssistantPortInput,
  type AssistantPortOutcome,
  isAssistantPortInput,
} from "../../domain/index.ts";

export type SyntheticBranch =
  | { readonly branch: "success"; readonly actualMicro: bigint; readonly text?: string }
  | { readonly branch: "provider_error"; readonly actualMicro?: bigint }
  | { readonly branch: "timeout" }
  | { readonly branch: "aborted_after_send" }
  /** The port times out; the answer arrives later through `deliverLate`. */
  | { readonly branch: "late_answer"; readonly actualMicro: bigint; readonly text?: string }
  /** Success whose cost is the reservation plus `overMicro` (R6). */
  | {
      readonly branch: "over_reservation";
      readonly reservedMicro: bigint;
      readonly overMicro: bigint;
      readonly text?: string;
    };

export const SYNTHETIC_BRANCHES = Object.freeze([
  "success",
  "provider_error",
  "timeout",
  "aborted_after_send",
  "late_answer",
  "over_reservation",
] as const satisfies readonly SyntheticBranch["branch"][]);

export type SyntheticAssistant = AssistantPort & {
  /** Every input the port received, in order. */
  readonly calls: readonly AssistantPortInput[];
  /** Late answers not yet delivered, oldest first. */
  readonly pendingLate: number;
  /** The oldest late answer, as it would arrive after the timeout; null if none. */
  deliverLate(): AssistantPortOutcome | null;
};

/** The deterministic answer text, cut to the port's longest answer. */
export function syntheticAnswer(input: AssistantPortInput, text?: string): string {
  const full = text ?? `Synthetic answer for purpose ${input.purposeKey}.`;
  return [...full].slice(0, input.maxResponseCodePoints).join("");
}

function outcomeOf(branch: SyntheticBranch, input: AssistantPortInput): AssistantPortOutcome {
  switch (branch.branch) {
    case "success":
      return {
        kind: "success",
        text: syntheticAnswer(input, branch.text),
        actualMicro: branch.actualMicro,
      };
    case "provider_error":
      return branch.actualMicro === undefined
        ? { kind: "provider_error" }
        : { kind: "provider_error", actualMicro: branch.actualMicro };
    case "timeout":
    case "late_answer":
      return { kind: "timeout" };
    case "aborted_after_send":
      return { kind: "aborted" };
    case "over_reservation":
      return {
        kind: "success",
        text: syntheticAnswer(input, branch.text),
        actualMicro: branch.reservedMicro + branch.overMicro,
      };
  }
}

function checkBranch(branch: SyntheticBranch): void {
  const amounts =
    branch.branch === "success" || branch.branch === "late_answer"
      ? [branch.actualMicro]
      : branch.branch === "provider_error"
        ? branch.actualMicro === undefined
          ? []
          : [branch.actualMicro]
        : branch.branch === "over_reservation"
          ? [branch.reservedMicro, branch.overMicro]
          : [];
  if (amounts.some((amount) => typeof amount !== "bigint" || amount < 0n)) {
    throw new TypeError("synthetic assistant: amounts are non-negative bigint micro-euros");
  }
  if (
    branch.branch === "over_reservation" &&
    (branch.reservedMicro <= 0n || branch.overMicro <= 0n)
  ) {
    throw new TypeError(
      "synthetic assistant: over_reservation needs a reservation and an excess above zero",
    );
  }
}

/**
 * A synthetic adapter. One branch repeats for every call; a list is used in
 * order, one branch per call, and a call past its end is a programming error.
 * An input that is not exactly a port input is a programming error too: the
 * adapter never forwards a field the port does not have.
 */
export function createSyntheticAssistant(
  script: SyntheticBranch | readonly SyntheticBranch[],
): SyntheticAssistant {
  const branches: readonly SyntheticBranch[] = Array.isArray(script)
    ? [...(script as readonly SyntheticBranch[])]
    : [script as SyntheticBranch];
  for (const branch of branches) checkBranch(branch);
  const repeat = !Array.isArray(script);
  const calls: AssistantPortInput[] = [];
  const late: AssistantPortOutcome[] = [];

  return {
    get calls() {
      return [...calls];
    },
    get pendingLate() {
      return late.length;
    },
    deliverLate() {
      return late.shift() ?? null;
    },
    complete(input) {
      if (!isAssistantPortInput(input)) {
        return Promise.reject(new TypeError("synthetic assistant: not a port input"));
      }
      const branch = repeat ? branches[0] : branches[calls.length];
      if (branch === undefined) {
        return Promise.reject(
          new RangeError("synthetic assistant: script has no branch for this call"),
        );
      }
      calls.push(input);
      if (branch.branch === "late_answer") {
        late.push({
          kind: "success",
          text: syntheticAnswer(input, branch.text),
          actualMicro: branch.actualMicro,
        });
      }
      return Promise.resolve(outcomeOf(branch, input));
    },
  };
}

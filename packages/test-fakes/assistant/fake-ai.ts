/**
 * A fake local AI provider behind the assistant port (SRV-FAKE-AI-LOCAL,
 * PRE-R02). It lets the whole app run locally with the assistant on, without a
 * secret, a paid API or a network connection: it imports only the port types
 * and constants, opens no socket and reads no key.
 *
 * It answers deterministically from invented sentences (the same paragraph
 * and purpose give the same bytes), and it names itself with an invented
 * provider and model that pass PROVIDER_ID_PATTERN and MODEL_ID_PATTERN. No
 * real provider or model name appears here (Q-10, provider-rules).
 *
 * It is never the default and never in production: `fakeAiFromEnv` returns it
 * only when DUCTURA_FAKE_AI_LOCAL=1 is set explicitly and NODE_ENV is unset,
 * development or test. The package guard and boundary.test.ts keep it out of
 * `server/`.
 */
import {
  type AssistantPort,
  type AssistantPortInput,
  type AssistantPortOutcome,
  isAssistantPortInput,
  MODEL_ID_PATTERN,
  PROVIDER_ID_PATTERN,
} from "../../../server/domain/index.ts";
import { assertFakeOidcAllowed } from "../oidc/index.ts";

/** Invented provider, as a faculty configuration entry would name it. */
export const FAKE_AI_PROVIDER_ID = "fake-local-ai";
export const FAKE_AI_MODEL_ID = "fake-local-model-1";
/** The only switch: explicit, local, never a default. */
export const FAKE_AI_ENV = "DUCTURA_FAKE_AI_LOCAL";

/** A faculty configuration entry for the fake; no real company, country codes are invented too. */
export const FAKE_AI_PROVIDER_ENTRY = Object.freeze({
  providerId: FAKE_AI_PROVIDER_ID,
  modelId: FAKE_AI_MODEL_ID,
  headquarters: "HR",
  modelDeveloperHeadquarters: "HR",
  processingCountries: Object.freeze(["HR"]),
});

if (!PROVIDER_ID_PATTERN.test(FAKE_AI_PROVIDER_ID) || !MODEL_ID_PATTERN.test(FAKE_AI_MODEL_ID)) {
  throw new Error("fake AI: invented provider or model id breaks the port patterns");
}

export const FAKE_AI_MODES = Object.freeze(["answer", "refuse", "timeout", "aborted"] as const);
export type FakeAiMode = (typeof FAKE_AI_MODES)[number];

/**
 * Scenario markers a tester can type at the start of a paragraph to force a
 * branch on a running local stack. They are read only from the paragraph data
 * part, so they steer this fake alone and never reach instructions.
 */
export const FAKE_AI_MARKERS = Object.freeze({
  refuse: "#odbij",
  timeout: "#istek",
  aborted: "#prekid",
} as const);

const ANSWERS = Object.freeze([
  "Izmišljeni odgovor: pokušajte jasnije povezati ovaj odlomak s prethodnim.",
  "Izmišljeni odgovor: tvrdnja bi bila uvjerljivija uz jedan konkretan primjer.",
  "Izmišljeni odgovor: razmislite o kraćim rečenicama i jednoj glavnoj misli po odlomku.",
  "Izmišljeni odgovor: provjerite slaže li se redoslijed misli s planom rada.",
]);

export type FakeAiOptions = {
  /** Branch for every call; a marker in the paragraph overrides it. Default `answer`. */
  readonly mode?: FakeAiMode;
  /** Cost reported with an answer, whole micro-euros. Default 0n: the fake invents no price. */
  readonly actualMicro?: bigint;
  /** Time the fake takes before it answers; default 0. */
  readonly delayMs?: number;
  /** The port times out when `delayMs` exceeds this; default no limit. */
  readonly timeoutMs?: number;
  /** An abort of this signal ends a waiting call as `aborted`. */
  readonly signal?: AbortSignal;
};

export type FakeAi = AssistantPort & {
  /** Every valid input the port received, in order. */
  readonly calls: readonly AssistantPortInput[];
};

/** FNV-1a over UTF-16 code units: a stable, dependency-free hash. */
function hashOf(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

function paragraphOf(input: AssistantPortInput): string {
  const parts = input.data.filter((part) => part.kind === "paragraph");
  return parts.length === 0 ? "" : (parts[parts.length - 1]?.text ?? "");
}

/** The deterministic answer text for an input. */
export function fakeAiAnswer(input: AssistantPortInput): string {
  const index = hashOf(`${input.purposeKey}\n${paragraphOf(input)}`) % ANSWERS.length;
  return ANSWERS[index] ?? ANSWERS[0] ?? "";
}

function markedMode(input: AssistantPortInput): FakeAiMode | null {
  const text = paragraphOf(input).trimStart().toLowerCase();
  for (const [mode, marker] of Object.entries(FAKE_AI_MARKERS)) {
    if (text.startsWith(marker)) return mode as FakeAiMode;
  }
  return null;
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<"done" | "aborted"> {
  if (signal?.aborted === true) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve("aborted");
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve("done");
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The fake adapter. An input that is not exactly a port input is a programming
 * error and rejects, like the synthetic adapter. A model id other than the
 * fake's own is refused as `provider_error`: it is the fake, not any other.
 */
export function createFakeAi(options: FakeAiOptions = {}): FakeAi {
  const { mode = "answer", actualMicro = 0n, delayMs = 0, timeoutMs, signal } = options;
  if (!(FAKE_AI_MODES as readonly string[]).includes(mode)) {
    throw new TypeError(`fake AI: unknown mode ${JSON.stringify(mode)}`);
  }
  if (typeof actualMicro !== "bigint" || actualMicro < 0n) {
    throw new TypeError("fake AI: actualMicro is a non-negative bigint of micro-euros");
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError("fake AI: delayMs is a non-negative number");
  }
  const calls: AssistantPortInput[] = [];

  return {
    get calls() {
      return [...calls];
    },
    async complete(input): Promise<AssistantPortOutcome> {
      if (!isAssistantPortInput(input)) {
        throw new TypeError("fake AI: not a port input");
      }
      calls.push(input);
      if (delayMs > 0) {
        if (timeoutMs !== undefined && delayMs > timeoutMs) {
          return (await wait(timeoutMs, signal)) === "aborted"
            ? { kind: "aborted" }
            : { kind: "timeout" };
        }
        if ((await wait(delayMs, signal)) === "aborted") return { kind: "aborted" };
      } else if (signal?.aborted === true) {
        return { kind: "aborted" };
      }
      if (input.modelId !== FAKE_AI_MODEL_ID) return { kind: "provider_error" };
      switch (markedMode(input) ?? mode) {
        case "answer":
          return { kind: "success", text: fakeAiAnswer(input), actualMicro };
        case "refuse":
          return { kind: "provider_error" };
        case "timeout":
          return { kind: "timeout" };
        case "aborted":
          return { kind: "aborted" };
      }
    },
  };
}

/** True only for the explicit local switch; anything else, unset included, is off. */
export function fakeAiSelected(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[FAKE_AI_ENV] === "1";
}

/**
 * The fake when the environment selects it explicitly, else null. Selecting it
 * with NODE_ENV outside unset, development and test throws instead of
 * returning null: a production process that asks for it is a misconfiguration.
 */
export function fakeAiFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  options: FakeAiOptions = {},
): FakeAi | null {
  if (!fakeAiSelected(env)) return null;
  assertFakeOidcAllowed(env);
  return createFakeAi(options);
}

// Fake storage, keys and email for the outside-service pattern (S-1E-c,
// DAN-837), each in the modes `ok`, `slow` and `down` of
// @ductura/test-fakes/services. Local runs and CI only; production code never
// imports test-support (docs/server-map.md §2). Every value is invented.
import { createFakeClock, type FakeClock } from "@ductura/test-fakes/clock";
import { FAKE_SERVICE_MODES, type FakeServiceMode } from "@ductura/test-fakes/services";

import type { EmailMessage, EmailSender } from "../../server/external/email/index.ts";
import {
  DevelopmentEd25519SigningKeyProvider,
  type SigningKeyProvider,
} from "../../server/external/keys/index.ts";
import {
  InMemoryEvidencePayloadStore,
  type GuardableStorage,
} from "../../server/external/storage/index.ts";

export type FakeServiceSetup = {
  readonly mode: FakeServiceMode;
  /** How long `slow` waits on the clock; default 30 000 ms. */
  readonly delayMs?: number;
  readonly clock?: FakeClock;
};

/** The mode as a gate in front of every call; `reached` counts calls that got to the service. */
export type FakeGate = {
  readonly mode: FakeServiceMode;
  readonly clock: FakeClock;
  readonly reached: () => number;
  pass(signal?: AbortSignal): Promise<void>;
};

export function createFakeGate(setup: FakeServiceSetup): FakeGate {
  if (!(FAKE_SERVICE_MODES as readonly string[]).includes(setup.mode))
    throw new Error(`fake service mode must be one of ${FAKE_SERVICE_MODES.join(", ")}`);
  const delayMs = setup.delayMs ?? 30_000;
  const clock = setup.clock ?? createFakeClock();
  let reached = 0;
  return {
    mode: setup.mode,
    clock,
    reached: () => reached,
    async pass(signal) {
      reached += 1;
      if (setup.mode === "down")
        throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
      if (setup.mode === "slow") await clock.sleep(delayMs, signal);
    },
  };
}

export function createFakeStorage(setup: FakeServiceSetup): GuardableStorage & { gate: FakeGate } {
  const gate = createFakeGate(setup);
  const store = new InMemoryEvidencePayloadStore();
  return {
    gate,
    putImmutable: async (input) => (await gate.pass(), store.putImmutable(input)),
    readImmutable: async (input) => (await gate.pass(), store.readImmutable(input)),
    headImmutable: async (input) => (await gate.pass(), store.headImmutable(input)),
  };
}

export function createFakeKeys(setup: FakeServiceSetup): SigningKeyProvider & { gate: FakeGate } {
  const gate = createFakeGate(setup);
  const signer = new DevelopmentEd25519SigningKeyProvider("fake-key-invalid", "fake-v1");
  return {
    gate,
    sign: async (message) => (await gate.pass(), signer.sign(message)),
    verify: async (message, signature) => (await gate.pass(), signer.verify(message, signature)),
    publicVerificationKey: async () => (await gate.pass(), signer.publicVerificationKey()),
  };
}

export function createFakeEmail(
  setup: FakeServiceSetup,
): EmailSender & { gate: FakeGate; sent: readonly EmailMessage[] } {
  const gate = createFakeGate(setup);
  const sent: EmailMessage[] = [];
  return {
    gate,
    sent,
    async send(message, signal) {
      await gate.pass(signal);
      sent.push(message);
      return { status: "sent" };
    },
  };
}

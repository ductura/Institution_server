// Public interface of the fake local AI provider (SRV-FAKE-AI-LOCAL).
import "../guard/index.ts";

export {
  createFakeAi,
  FAKE_AI_ENV,
  FAKE_AI_MARKERS,
  FAKE_AI_MODEL_ID,
  FAKE_AI_MODES,
  FAKE_AI_PROVIDER_ENTRY,
  FAKE_AI_PROVIDER_ID,
  fakeAiAnswer,
  fakeAiFromEnv,
  fakeAiSelected,
  type FakeAi,
  type FakeAiMode,
  type FakeAiOptions,
} from "./fake-ai.ts";

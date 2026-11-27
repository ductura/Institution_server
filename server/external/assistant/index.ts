// Public interface of the AI assistant adapters (Ductus
// docs/contracts/ai-request-v1.md, "Port i sintetički adapter"). Areas other
// than `http` import it with `import type` only (docs/server-map.md §2). Only
// the synthetic adapter exists; the real one waits for M9.1 (OA-1).
export {
  SYNTHETIC_BRANCHES,
  createSyntheticAssistant,
  syntheticAnswer,
  type SyntheticAssistant,
  type SyntheticBranch,
} from "./synthetic-assistant.ts";
// The gated provider port and the institution setting (SRV-1809, M9.0-S2,
// M9.0-S3): ai_disabled unless the setting is on, the cost configuration is
// complete and an adapter is composed.
export {
  AI_DISABLED_RULES,
  COST_LIMIT_KEYS,
  createAssistantProviderPort,
  createProductionAssistantProviderPort,
  isCostConfigured,
  type AiDisabledRule,
  type AssistantProviderOutcome,
  type AssistantProviderPort,
  type AssistantProviderPortDeps,
} from "./provider-port.ts";
export {
  ASSISTANT_SETTING_OFF,
  institutionAiSwitchOf,
  PRODUCTION_ASSISTANT_SETTING,
  readAssistantSetting,
  type AssistantInstitutionSetting,
} from "./institution-setting.ts";
// What the AI proxy route (server/http/assistant, SRV-1204) needs from the
// domain to drive the port: http may not import domain (docs/server-map.md
// §2), so it reads them here, next to the port they serve.
export {
  AI_POLICIES,
  buildPortInput,
  checkResponse,
  composeInstructions,
  parseAssistantRequest,
  parseProviderEntry,
  PURPOSE_CATALOG_VERSIONS,
  type AiPolicy,
  type AssignmentRules,
  type AssistantPort,
  type AssistantPortInput,
  type AssistantPortOutcome,
  type AssistantRequest,
  type ProviderEntry,
  type ProviderEntryRule,
  type PurposeCatalogVersion,
} from "../../domain/index.ts";
// The OpenAI adapter (F4-PM2-R11, D-316): composed only with a key, a model
// and prices from the environment; without them the port stays ai_disabled.
export {
  costOf,
  createOpenAiAssistant,
  OPENAI_BASE_URL,
  OPENAI_BASE_URL_VARIABLE,
  OPENAI_BASE_URLS,
  OPENAI_EU_BASE_URL,
  OPENAI_US_BASE_URL,
  openAiBaseUrlOf,
  openAiBaseUrlProblems,
  type OpenAiAssistantDeps,
  type OpenAiBaseUrlEnv,
  type OpenAiCallMetadata,
  type OpenAiTransport,
  type OpenAiTransportRequest,
  type OpenAiTransportResponse,
} from "./openai-assistant.ts";

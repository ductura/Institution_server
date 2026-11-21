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

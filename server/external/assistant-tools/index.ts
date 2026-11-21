// Public interface of the AI assistant's tools (Ductus
// docs/contracts/ai-tools-v1.md, steps 4 and 5; SRV-1207). Areas other than
// `http` import it with `import type` only (docs/server-map.md §2). The faculty
// setting reader (OC-1), the search guard with an empty pilot destination list
// and no transport (OC-2), and the tool loop the AI route drives.
export {
  facultyAiSettingsOf,
  FACULTY_CONFIG_MAX_BYTES,
  readFacultyAiConfigFile,
  readFacultyAiSettings,
  type FacultyAiSettings,
} from "./faculty-config.ts";
export {
  createSearchGuard,
  FETCH_MAX_BYTES,
  isPublicAddress,
  NO_TRANSPORT,
  SEARCH_FAIL_RULES,
  type SearchFailRule,
  type SearchGuard,
  type SearchOutcome,
  type SearchTransport,
} from "./search-guard.ts";
export {
  runToolLoop,
  type BeginStep,
  type FinishStep,
  type ToolLoopDeps,
  type ToolLoopInput,
  type ToolLoopResult,
} from "./tool-loop.ts";
// What the AI route needs from the domain beside the loop: http may not import
// domain (docs/server-map.md §2).
export { type SearchDestination, type ToolName } from "../../domain/index.ts";

import type { ESLint } from "eslint";
import { kebabCaseFilename, onlyTs, testFileSuffix } from "./file-name.ts";
import { noFakeServerImport } from "./fake-server-boundary.ts";
import { areaBoundary } from "./area-boundary.ts";
import { importBoundary } from "./import-boundary.ts";
import { noDynamicLoad } from "./dynamic-load.ts";
import { noHardcodedText } from "./hardcoded-text.ts";

/** Repository-local ESLint rules, registered under the `local` plugin name. */
export const localPlugin: ESLint.Plugin = {
  meta: { name: "local" },
  rules: {
    "kebab-case-filename": kebabCaseFilename,
    "test-file-suffix": testFileSuffix,
    "only-ts": onlyTs,
    "import-boundary": importBoundary,
    "area-boundary": areaBoundary,
    "no-fake-server-import": noFakeServerImport,
    "no-dynamic-load": noDynamicLoad,
    "no-hardcoded-text": noHardcodedText,
  },
};
export { databaseBoundaryPlugin, PG_SPECIFIER } from "./database-boundary.ts";
export { AREA_IMPORTS, areaOf, ENTRY } from "./area-boundary.ts";
export {
  DYNAMIC_LOAD_ALLOWED,
  IMPORT_META,
  KEY_LITERAL_ALLOWED,
  LOADER_GLOBALS,
} from "./dynamic-load.ts";
export { isExempt, STRONG_WORDS, TEXT_EXEMPT, textProblem, WEAK_WORDS } from "./hardcoded-text.ts";
export { TEST_ONLY_RE } from "./fake-server-boundary.ts";

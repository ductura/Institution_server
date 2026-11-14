import type { ESLint } from "eslint";
import { kebabCaseFilename, onlyTs, testFileSuffix } from "./file-name.ts";
import { importBoundary } from "./import-boundary.ts";

/** Repository-local ESLint rules, registered under the `local` plugin name. */
export const localPlugin: ESLint.Plugin = {
  meta: { name: "local" },
  rules: {
    "kebab-case-filename": kebabCaseFilename,
    "test-file-suffix": testFileSuffix,
    "only-ts": onlyTs,
    "import-boundary": importBoundary,
  },
};
export { databaseBoundaryPlugin, PG_SPECIFIER } from "./database-boundary.ts";

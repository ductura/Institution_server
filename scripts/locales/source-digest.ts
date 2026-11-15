/**
 * Recomputes `SOURCE_DIGESTS` of locales/source.ts from a Ductus checkout, so
 * a reviewer can check the values the port is compared with (S-1L.1, DAN-768).
 *
 *   git -C <ductus> checkout d52a92c3a108f3f0ec9c3639188a2ea669bba582
 *   pnpm tsx scripts/locales/source-digest.ts <ductus>
 *
 * Prints the digest of each source table and whether it matches the recorded
 * one; exits 1 when one differs. A source table has no runtime imports (only
 * `import type`), so it is transpiled to CommonJS and run in a fresh context
 * instead of imported.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

import ts from "typescript";

import { digestOf, SOURCE, SOURCE_DIGESTS } from "../../locales/index.ts";

export type SourceCheck = {
  language: "hr" | "en";
  texts: number;
  sha256: string;
  matches: boolean;
};

const EXPORTS = { hr: "messagesHr", en: "messagesEn" } as const;

/** The exports of a TypeScript module without runtime imports. */
function evaluate(file: string): Record<string, unknown> {
  const { outputText } = ts.transpileModule(readFileSync(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 },
  });
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(outputText, { module, exports: module.exports }, { filename: file });
  return module.exports;
}

/** The digest of each source table in `checkout`, compared with the recorded one. */
export function checkSource(checkout: string): SourceCheck[] {
  return (["hr", "en"] as const).map((language) => {
    const table = evaluate(path.resolve(checkout, SOURCE[language].path))[EXPORTS[language]];
    const { texts, sha256 } = digestOf(table);
    const want = SOURCE_DIGESTS[language];
    return { language, texts, sha256, matches: texts === want.texts && sha256 === want.sha256 };
  });
}

function main(checkout: string | undefined): number {
  if (!checkout) {
    console.error("usage: tsx scripts/locales/source-digest.ts <ductus checkout>");
    return 2;
  }
  const checks = checkSource(checkout);
  for (const { language, texts, sha256, matches } of checks)
    console.log(`${language} ${texts} ${sha256} ${matches ? "matches" : "DIFFERS"}`);
  return checks.every((check) => check.matches) ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv[2]);
}

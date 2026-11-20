import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, type Linter } from "eslint";
import { describe, expect, it } from "vitest";

import { COPIED_LINT_RULES, COPIED_LINT_TRANSITIONAL } from "../../scripts/lint-rules/index.ts";
import { PENDING_TESTS } from "../../scripts/pending-tests/index.ts";

// COPIED_LINT_TRANSITIONAL (the copied Ductus backend, Ductus#2028) only
// shrinks: each listed file must still break each rule listed for it. The
// rule is switched back on for the file with the options the repository
// config gives a file next to it that is not on the list, so the folder's own
// options (naming lists of server/database, tests/db, storage) apply.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FLAGS = ["unstable_native_nodejs_ts_config"];
const CONFIG = path.join(ROOT, "eslint.config.ts");
const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: CONFIG, flags: FLAGS });
const entries = Object.entries(COPIED_LINT_TRANSITIONAL);

/** The rule entry the config gives an unlisted file in the same folder. */
async function entryNextTo(file: string, rule: string): Promise<Linter.RuleEntry | undefined> {
  const probe = path.join(ROOT, path.dirname(file), `copied-probe${path.extname(file)}`);
  const config = (await eslint.calculateConfigForFile(probe)) as {
    rules?: Record<string, Linter.RuleEntry>;
  };
  return config.rules?.[rule];
}

describe("COPIED_LINT_TRANSITIONAL", () => {
  it("lists existing files, sorted, only with its own rules, none of them pending", () => {
    const files = entries.map(([file]) => file);
    expect(files).toEqual([...files].sort());
    for (const [file, rules] of entries) {
      expect(existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(PENDING_TESTS, file).not.toContain(file);
      expect(rules.length, file).toBeGreaterThan(0);
      expect(new Set(rules).size, file).toBe(rules.length);
      for (const rule of rules) expect(COPIED_LINT_RULES, `${file} ${rule}`).toContain(rule);
    }
  });

  it("switches each listed rule off for its files only", async () => {
    for (const [file, rules] of entries) {
      const config = (await eslint.calculateConfigForFile(path.join(ROOT, file))) as {
        rules?: Record<string, Linter.RuleEntry>;
      };
      for (const rule of rules) {
        const entry = config.rules?.[rule];
        expect(Array.isArray(entry) ? entry[0] : entry, `${file} ${rule}`).toBe(0);
      }
    }
  });

  // Lints the listed files once per listed rule (about 230 files): its own budget.
  const LINT_LISTED_TIMEOUT_MS = 120_000;
  it(
    "holds only files that still break every rule listed for them",
    async () => {
      // One ESLint per rule and folder options, running only that rule.
      const groups = new Map<string, { rule: string; entry: Linter.RuleEntry; files: string[] }>();
      for (const [file, rules] of entries) {
        for (const rule of rules) {
          const entry = await entryNextTo(file, rule);
          expect(entry, `${file} ${rule}`).toBeDefined();
          if (entry === undefined) continue;
          const key = `${rule} ${JSON.stringify(entry)}`;
          const group = groups.get(key) ?? { rule, entry, files: [] };
          group.files.push(file);
          groups.set(key, group);
        }
      }
      const clean: string[] = [];
      for (const { rule, entry, files } of groups.values()) {
        const strict = new ESLint({
          cwd: ROOT,
          overrideConfigFile: CONFIG,
          flags: FLAGS,
          overrideConfig: { files, rules: { [rule]: entry } },
          ruleFilter: ({ ruleId }) => ruleId === rule,
        });
        const results = await strict.lintFiles(files);
        for (const result of results) {
          const file = path.relative(ROOT, result.filePath).split(path.sep).join("/");
          if (!result.messages.some((m) => m.ruleId === rule)) clean.push(`${file} ${rule}`);
        }
      }
      expect(clean, "take these off COPIED_LINT_TRANSITIONAL").toEqual([]);
    },
    LINT_LISTED_TIMEOUT_MS,
  );
});

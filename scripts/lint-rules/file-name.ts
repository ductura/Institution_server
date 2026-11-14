import path from "node:path";
import type { Rule } from "eslint";

const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_TEST = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.property|\.integration)?\.test\.ts$/;
const TEST_SEGMENTS = new Set(["test", "tests", "spec", "specs", "e2e", "unit", "property", "integration"]);
const TEST_WORD = /(?:^|-)(?:test|spec)s?$/;

/** Name parts of a file: "a-b.property.test.ts" -> ["a-b", "property", "test"]. */
function nameParts(filename: string): string[] {
  const base = path.basename(filename);
  return base.slice(0, base.length - path.extname(base).length).split(".");
}

/** Every dot-separated part of the file name is kebab-case. */
export const kebabCaseFilename: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "File names are kebab-case" },
    messages: { kebab: "File name '{{name}}' must be kebab-case (lowercase words joined by '-')." },
    schema: [],
  },
  create(context) {
    return {
      Program(node) {
        if (!nameParts(context.filename).every((part) => KEBAB.test(part))) {
          context.report({ node, messageId: "kebab", data: { name: path.basename(context.filename) } });
        }
      },
    };
  },
};

/** A file that looks like a test ends in .test.ts, .property.test.ts or .integration.test.ts. */
export const testFileSuffix: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Tests use only the allowed suffixes" },
    messages: {
      suffix: "Test file '{{name}}' must end in .test.ts, .property.test.ts or .integration.test.ts.",
    },
    schema: [],
  },
  create(context) {
    return {
      Program(node) {
        const name = path.basename(context.filename);
        const [first = "", ...rest] = nameParts(context.filename);
        const looksLikeTest = TEST_WORD.test(first) || rest.some((part) => TEST_SEGMENTS.has(part));
        if (looksLikeTest && !ALLOWED_TEST.test(name)) {
          context.report({ node, messageId: "suffix", data: { name } });
        }
      },
    };
  },
};

/** Source code is TypeScript only: any other script extension fails. */
export const onlyTs: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "Only .ts source files" },
    messages: { onlyTs: "Only .ts source files are allowed; rename '{{name}}'." },
    schema: [],
  },
  create(context) {
    return {
      Program(node) {
        if (path.extname(context.filename) !== ".ts") {
          context.report({ node, messageId: "onlyTs", data: { name: path.basename(context.filename) } });
        }
      },
    };
  },
};

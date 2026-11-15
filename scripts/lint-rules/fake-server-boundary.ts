import { dirname, posix } from "node:path";
import type { Rule } from "eslint";

import { specifierVisitors } from "./database-boundary.ts";

// The generated fake server folder of the contracts (U8), however the path
// reaches it: either slash, unnormalized segments, a query or fragment suffix.
const FAKE_SERVER_RE = /(?:^|\/)generated\/fake-server(?:$|[/?#])/u;

/**
 * True when a module specifier, read from the file `from`, names the fake
 * server or a file in its folder. A relative specifier is also resolved against
 * the importing file, so `./fake-server/index.ts` from generated/ is caught.
 */
export function isFakeServer(specifier: string, from: string): boolean {
  const slashed = specifier.trim().replace(/\\/g, "/");
  const base = dirname(from).replace(/\\/g, "/");
  const resolved = /^\.\.?(?:\/|$)/.test(slashed) ? [posix.join(base, slashed)] : [];
  return [slashed, posix.normalize(slashed), ...resolved].some((path) => FAKE_SERVER_RE.test(path));
}

/**
 * The contract fake server answers with made-up vectors and is for tests only.
 * Reports it in every form a file can load a module with: static import and
 * export, import() and require, by the specifier as written and resolved. eslint.config.ts switches the rule off only for
 * test files, server/test-server and test-support; no other block turns it off.
 */
export const noFakeServerImport: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: { description: "The contract fake server is imported only by test code" },
    schema: [],
    messages: { fakeServer: "The contract fake server is for tests only." },
  },
  create(context) {
    return specifierVisitors(
      context,
      (specifier) => isFakeServer(specifier, context.filename),
      "fakeServer",
    );
  },
};

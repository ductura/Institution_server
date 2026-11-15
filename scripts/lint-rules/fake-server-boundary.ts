import { posix } from "node:path";
import type { Rule } from "eslint";

import { specifierVisitors } from "./database-boundary.ts";

// The generated fake server folder of the contracts (U8), however the path
// reaches it: either slash, unnormalized segments, a query or fragment suffix.
const FAKE_SERVER_RE = /(?:^|\/)generated\/fake-server(?:$|[/?#])/u;

/** True when a module specifier names the fake server or a file in its folder. */
export function isFakeServer(specifier: string): boolean {
  const slashed = specifier.trim().replace(/\\/g, "/");
  return FAKE_SERVER_RE.test(slashed) || FAKE_SERVER_RE.test(posix.normalize(slashed));
}

/**
 * The contract fake server answers with made-up vectors and is for tests only.
 * Reports it in every form a file can load a module with: static import and
 * export, import() and require. eslint.config.ts switches the rule off only for
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
    return specifierVisitors(context, isFakeServer, "fakeServer");
  },
};

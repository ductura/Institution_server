// Every target the router would serve on an operator path is an operator path
// for the IP rules (S-1C.2, DAN-832-1): the rule is broader than the router.
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isOpsPath } from "../traffic/index.ts";
import { routePath } from "./router.ts";

const piece = fc.stringMatching(/^[A-Za-z0-9._~%;:@!$&'()*+,=/?#-]{0,12}$/u);

describe("isOpsPath covers the router", () => {
  it("a target routePath reads as /api/v1/ops or below is an operator path", () => {
    fc.assert(
      fc.property(piece, (tail) => {
        for (const target of [`/api/v1/ops${tail}`, `/api/v1/ops/${tail}`]) {
          const path = routePath(target);
          if (path === "/api/v1/ops" || path?.startsWith("/api/v1/ops/") === true) {
            expect(isOpsPath(target)).toBe(true);
          }
        }
      }),
    );
  });
});

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { checkTag, CONTRACTS } from "./index.ts";

// DAN-869: a contracts tag on its own package.json floor passes exactly when its
// major is not below the major of API_VERSION. Every value is invented.
const part = fc.integer({ min: 0, max: 30 });

describe("checkTag (property)", () => {
  it("accepts contracts exactly when its major is at least the API major", () => {
    fc.assert(
      fc.property(part, part, part, part, part, (major, minor, apiMajor, apiMinor, apiPatch) => {
        const refName = `contracts-v${major}.${minor}.0`;
        const run = () =>
          checkTag({
            ref: `refs/tags/${refName}`,
            refName,
            sha: "c".repeat(40),
            version: (spec) => (spec === CONTRACTS ? `${major}.0.0` : "1.0.0"),
            apiVersion: `${apiMajor}.${apiMinor}.${apiPatch}`,
            onMain: () => true,
          });
        if (major >= apiMajor) expect(run()).toBe("contracts");
        else expect(run).toThrow(/is below the major of API_VERSION/);
      }),
    );
  });
});

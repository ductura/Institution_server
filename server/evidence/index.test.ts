import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { EvidenceService } from "./index.ts";

describe("server/evidence public interface", () => {
  it("exports no value yet (DAN-815 b1)", () => {
    expect(Object.keys(area)).toEqual([]);
  });

  it("has a service type without members", () => {
    expectTypeOf<keyof EvidenceService>().toEqualTypeOf<string>();
    expectTypeOf<EvidenceService[string]>().toEqualTypeOf<never>();
  });
});

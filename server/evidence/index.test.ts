import { describe, expect, it } from "vitest";
import * as domain from "../domain/index.ts";
import * as area from "./index.ts";

describe("server/evidence public interface", () => {
  it("exports the service factory and the domain's wire limits, nothing else", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DUCTUS_ASYNC_COMMIT_PROTOCOL",
      "DUCTUS_PROTOCOL_VERSION",
      "MAX_COMMIT_REQUEST_BYTES",
      "createEvidenceService",
    ]);
  });

  it("B2: the limits http reads are the domain's own, one size on client and server", () => {
    expect(area.MAX_COMMIT_REQUEST_BYTES).toBe(domain.MAX_COMMIT_REQUEST_BYTES);
    expect(area.DUCTUS_PROTOCOL_VERSION).toBe(domain.DUCTUS_PROTOCOL_VERSION);
    expect(area.DUCTUS_ASYNC_COMMIT_PROTOCOL).toBe(domain.DUCTUS_ASYNC_COMMIT_PROTOCOL);
  });
});

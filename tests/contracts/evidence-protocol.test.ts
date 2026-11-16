// DAN-811: server/http may not import server/domain (docs/server-map.md §2),
// so the open route states its protocol itself; this keeps the two equal.
import { describe, expect, it } from "vitest";

import { DUCTUS_PROTOCOL_VERSION } from "../../server/domain/index.ts";
import { OPEN_PROTOCOLS } from "../../server/http/index.ts";

describe("the protocol of evidence/open", () => {
  it("is the domain's DUCTUS_PROTOCOL_VERSION and nothing else", () => {
    expect(OPEN_PROTOCOLS).toEqual([DUCTUS_PROTOCOL_VERSION]);
  });
});

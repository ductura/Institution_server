// "Ugovoreno, nije implementirano" (DAN-803, Ductus#1836 c.6905207008 t. 0.1):
// a route in CONTRACT_ONLY has a contract that clients build against on the
// fake server, and no handler on this server. A handler mounted for it while
// it is still listed fails here, so the list cannot claim a route is unserved
// when it is served. A cross-area test (docs/server-map.md §2), as
// tests/contracts/evidence-domain.test.ts; outside server/http on purpose.
import { describe, expect, it } from "vitest";

import { CONTRACT_ONLY, ROUTES } from "../../server/contracts/index.ts";
import { AREA_NAMES, routesOf } from "../../server/http/index.ts";

// Every route of DAN-803 (c.6905207008, 27 operations); after that task the
// list only shrinks, as handlers land.
const MOST = 27;

describe("CONTRACT_ONLY", () => {
  it("names routes that have a contract, each once", () => {
    const ids = new Set(ROUTES.map((route) => route.id));
    expect(CONTRACT_ONLY.filter((id) => !ids.has(id))).toEqual([]);
    expect(new Set(CONTRACT_ONLY).size).toBe(CONTRACT_ONLY.length);
    expect(CONTRACT_ONLY.length).toBeLessThanOrEqual(MOST);
  });

  it("names no route that an area mounts", () => {
    const mounted = routesOf(AREA_NAMES).map((route) => route.contract.id);
    expect(CONTRACT_ONLY.filter((id) => mounted.includes(id))).toEqual([]);
  });

  it("names no route that health or the evidence routes already had before DAN-803", () => {
    expect(CONTRACT_ONLY).not.toContain("platform.health.get");
    expect(CONTRACT_ONLY.every((id) => !id.startsWith("evidence."))).toBe(true);
  });
});

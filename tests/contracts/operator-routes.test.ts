// An operator route declares itself twice (S-1J.2, DAN-842-2; contract
// Ductus#1836 c.6947114430): id area `ops` and a path under /api/v1/ops,
// which is all step 8 reads. Over every contract and over invented input.
// That no mounted route goes around step 8 at run time is checked by
// server/operator-routes.integration.test.ts over the real entry point.
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

import { describe, expect, it } from "vitest";

import { ROUTES } from "../../server/contracts/index.ts";
import { createLayers, PIPELINE_STEPS } from "../../server/http/index.ts";
import { isOpsPath } from "../../server/traffic/index.ts";

type RouteLike = { readonly id: string; readonly path: string };

/** Routes that declare themselves operator routes only once. */
export function operatorRouteProblems(routes: readonly RouteLike[]): string[] {
  return routes.flatMap(({ id, path }) => {
    const byId = id.split(".", 1)[0] === "ops";
    const byPath = isOpsPath(path);
    if (byId && !byPath) return [`${id}: operator route outside /api/v1/ops`];
    if (!byId && byPath) return [`${id}: ${path} is an operator path, the id is not ops.*`];
    return [];
  });
}

describe("operator routes declare themselves twice", () => {
  it.each([
    [{ id: "ops.traffic.get", path: "/api/v1/traffic" }],
    [{ id: "settings.network.get", path: "/api/v1/ops/network" }],
    [{ id: "settings.root.get", path: "/api/v1/ops" }],
    // Not a contract path (check.ts: path === pathOf(inventory)); invented only.
    [{ id: "platform.x.get", path: "/api/v1/OPS/x" }],
    [{ id: "platform.x.get", path: "//api/v1//ops/x" }],
  ])("refuses a route that declares itself only once: %o", (route) => {
    expect(operatorRouteProblems([route])).toHaveLength(1);
  });

  it.each([
    [{ id: "ops.traffic.get", path: "/api/v1/ops/traffic" }],
    [{ id: "opsx.y.get", path: "/api/v1/opsx/y" }],
    [{ id: "platform.ops.get", path: "/api/v1/health" }],
  ])("accepts %o", (route) => {
    expect(operatorRouteProblems([route])).toEqual([]);
  });

  it("holds for every contract", () => {
    expect(operatorRouteProblems(ROUTES)).toEqual([]);
  });

  it("step 8 is in the pipeline and createLayers gives the real layer", async () => {
    expect(PIPELINE_STEPS).toContain("operatorPolicy");
    const request = new IncomingMessage(new Socket());
    request.url = "/api/v1/ops/x";
    const response = new ServerResponse(request);
    expect(await createLayers({ expectedOrigin: null }).operatorPolicy(request, response)).toBe(
      "done",
    );
    expect(response.statusCode).toBe(401);
  });
});

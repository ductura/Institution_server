// DAN-857-1: whatever a client encodes as a path value (encodeURIComponent, as
// server/contracts/generated/client.ts does), the router hands over as sent,
// and workIdFromPath gives back the value exactly when it is a work id.
import type { IncomingMessage, ServerResponse } from "node:http";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { isWorkId, ROUTES, workIdFromPath } from "../contracts/index.ts";
import { createRouter, type Route } from "./router.ts";

const LIVE_GET = ROUTES.find((route) => route.id === "live.document.get");
if (LIVE_GET === undefined) throw new Error("live.document.get");
const seen: unknown[] = [];
const route: Route = {
  contract: LIVE_GET,
  handle: async (_q, _r, params) => void seen.push(params),
};
const router = createRouter([route]);
// Only what the router touches on the way to a handler that writes nothing.
const response = () => ({ writeHead: () => undefined }) as never as ServerResponse;

describe("path parameters round trip", () => {
  it("hands over what encodeURIComponent encoded, as sent", async () => {
    // "." and ".." stay unencoded and are dot segments: routePath refuses them.
    const value = fc
      .string({ unit: "grapheme", minLength: 1 })
      .filter((s) => s !== "." && s !== "..");
    await fc.assert(
      fc.asyncProperty(value, async (s) => {
        seen.length = 0;
        const raw = encodeURIComponent(s);
        await router({ method: "GET", url: `/api/v1/live/${raw}` } as IncomingMessage, response());
        expect(seen).toEqual([{ documentId: raw }]);
        expect(workIdFromPath(raw)).toBe(isWorkId(s) ? s : null);
      }),
    );
  });
});

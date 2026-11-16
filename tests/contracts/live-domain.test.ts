// DAN-803: the live-view vectors against the domain rules the route copies
// (Ductus 078c780 live-route.ts). A cross-area test: server/contracts may
// import nothing from the server (docs/server-map.md §2), as
// tests/contracts/evidence-domain.test.ts.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { VECTORS } from "../../server/contracts/generated/fake-server/index.ts";
import { canonicalJson } from "../../server/contracts/generated/index.ts";
import { verifyDocumentSnapshot } from "../../server/domain/index.ts";

const ETAG = /^"([0-9a-f]{64})"$/u;
const live = (route: string, status: number) =>
  VECTORS.filter((v) => v.route === route && v.response.status === status);

describe("live.document.put vectors", () => {
  it("every accepted or conflicting request is a document the domain accepts", async () => {
    const answered = [...live("live.document.put", 200), ...live("live.document.put", 409)];
    expect(answered.length).toBeGreaterThanOrEqual(5);
    for (const v of answered) {
      const bytes = new TextEncoder().encode(canonicalJson(v.request.body));
      expect((await verifyDocumentSnapshot(bytes)).ok, v.name).toBe(true);
    }
  });

  it("the invalid-document vector is one the domain refuses", async () => {
    const [v] = VECTORS.filter(
      (x) => x.route === "live.document.put" && x.name === "invalid-document",
    );
    const bytes = new TextEncoder().encode(canonicalJson(v?.request.body));
    expect((await verifyDocumentSnapshot(bytes)).ok).toBe(false);
  });
});

describe("live.document.get vectors", () => {
  it("a 200 serves a valid snapshot whose ETag is the sha256 of its JCS bytes", async () => {
    const served = live("live.document.get", 200);
    expect(served.length).toBeGreaterThanOrEqual(2);
    for (const v of served) {
      const text = canonicalJson(v.response.body);
      expect((await verifyDocumentSnapshot(new TextEncoder().encode(text))).ok, v.name).toBe(true);
      const hash = createHash("sha256").update(text, "utf8").digest("hex");
      expect(v.response.headers?.["etag"], v.name).toBe(`"${hash}"`);
    }
  });

  it("a 304 answers an If-None-Match of the exact ETag form, with that ETag", () => {
    for (const v of live("live.document.get", 304)) {
      const sent = v.request.headers?.["if-none-match"] ?? "";
      expect(ETAG.test(sent), v.name).toBe(true);
      expect(v.response.headers?.["etag"]).toBe(sent);
    }
  });

  it("a success needs no Sec-Fetch-Site: Node and the desktop do not send it", () => {
    for (const v of VECTORS.filter(
      (x) => x.route === "live.document.get" && x.response.status < 400,
    ))
      expect(v.request.headers?.["sec-fetch-site"], v.name).toBeUndefined();
  });
});

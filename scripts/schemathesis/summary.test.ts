// ISTR-7: the summary of a Schemathesis run counts per route and fails closed on anything out of scope.
import { describe, expect, it } from "vitest";

import { formatSummary, type Har, summarize } from "./summary.ts";

const origin = "http://localhost:4000";
const entry = (method: string, url: string, status: number) => ({
  request: { method, url },
  response: { status },
});
const allowlist = ["/api/v1/me", "/api/v1/status"];

describe("summarize", () => {
  it("counts statuses per route and reports nothing on a clean run", () => {
    const har: Har = {
      log: {
        entries: [
          entry("GET", `${origin}/api/v1/me?x=1`, 200),
          entry("GET", `${origin}/api/v1/me`, 422),
          entry("GET", `${origin}/api/v1/status`, 200),
          entry("GET", `${origin}/api/v1/status`, 503),
        ],
      },
    };
    const summary = summarize(
      { operations: { selected: 2 }, failures: [] },
      har,
      allowlist,
      origin,
    );
    expect(summary.routes).toEqual([
      { path: "/api/v1/me", requests: 2, ok: 1, clientError: 1, serverError: 0 },
      { path: "/api/v1/status", requests: 2, ok: 1, clientError: 0, serverError: 1 },
    ]);
    expect(summary).toMatchObject({ unchecked: [], disagreements: [], errors: 0, scope: [] });
  });

  it("reports a field outside the schema as a disagreement of that route", () => {
    const report = {
      operations: { selected: 2 },
      failures: [
        {
          code: "ST108",
          title: "Response violates schema",
          count: 3,
          operations: ["GET /api/v1/me"],
        },
      ],
    };
    const summary = summarize(report, { log: { entries: [] } }, allowlist, origin);
    expect(summary.disagreements).toEqual([
      {
        code: "ST108",
        title: "Response violates schema",
        count: 3,
        operations: ["GET /api/v1/me"],
      },
    ]);
    expect(summary.unchecked).toEqual(allowlist);
  });

  it("marks the run invalid when it left its scope", () => {
    const har: Har = {
      log: {
        entries: [
          entry("TRACE", `${origin}/api/v1/me`, 405),
          entry("GET", "http://elsewhere:1/api/v1/me", 200),
          entry("GET", `${origin}/api/v1/notifications`, 200),
        ],
      },
    };
    const report = {
      operations: { selected: 3 },
      warnings: Object.fromEntries([["unmatched_filter", ["path regex"]]]),
    };
    expect(summarize(report, har, allowlist, origin).scope).toEqual([
      "filter matched nothing: path regex",
      "selected 3 operations, allowlist has 2",
      "request outside scope: method TRACE",
      "request outside scope: origin http://elsewhere:1",
      "request outside scope: route /api/v1/notifications",
    ]);
  });

  it("treats a report without a selected count as out of scope", () => {
    expect(summarize({}, { log: { entries: [] } }, allowlist, origin).scope).toEqual([
      "selected ? operations, allowlist has 2",
    ]);
  });
});

describe("formatSummary", () => {
  it("prints counts and route names only", () => {
    const har: Har = { log: { entries: [entry("GET", `${origin}/api/v1/me`, 200)] } };
    const text = formatSummary(summarize({ operations: { selected: 2 } }, har, allowlist, origin));
    expect(text).toContain("Rute: 2, provjerene (barem jedan 2xx): 1");
    expect(text).toContain("/api/v1/me | 1 | 1 | 0 | 0");
    expect(text).toContain("Nisu provjerene (0 × 2xx): /api/v1/status");
    expect(text).not.toContain("IZVAN OPSEGA");
  });
});

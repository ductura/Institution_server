// ISTR-7: the pieces of run.ts that keep a probe in scope and the session cookie out of its reports.
// The end-to-end check against Schemathesis itself is `node scripts/schemathesis/run.ts --samotest`.
import { describe, expect, it } from "vitest";

import {
  configToml,
  leaksIn,
  type ProbeResult,
  restrictSpec,
  selfTestProblems,
  SELF_PATHS,
  SELF_SPEC,
  stackExitCode,
} from "./run.ts";

describe("restrictSpec", () => {
  it("keeps only the GET operations of the listed paths", () => {
    const spec = {
      openapi: "3.0.3",
      components: { schemas: {} },
      paths: {
        ...SELF_SPEC.paths,
        "/api/v1/p": { parameters: [{ name: "q", in: "query" }], get: {}, delete: {} },
      },
    };
    const restricted = restrictSpec(spec, [...SELF_PATHS, "/api/v1/p"]);
    expect(Object.keys(restricted.paths)).toEqual([...SELF_PATHS, "/api/v1/p"]);
    for (const item of Object.values(restricted.paths))
      expect(Object.keys(item).filter((key) => key !== "parameters")).toEqual(["get"]);
    expect(restricted.paths["/api/v1/p"]).toHaveProperty("parameters");
    expect(restricted.components).toBe(spec.components);
  });
});

describe("configToml", () => {
  it("reads the cookie from the environment, turns off undeclared methods and the crash cache", () => {
    const toml = configToml("__Host-ductus_session", { origin: "http://localhost:4000" });
    expect(toml).toContain('Cookie = "__Host-ductus_session=${DUCTUS_ST_SESSION}"');
    expect(toml).toContain('"origin" = "http://localhost:4000"');
    expect(toml).toMatch(/\[phases\.coverage\]\nunexpected-methods = \[\]/u);
    expect(toml).toMatch(/\[cache\]\nenabled = false/u);
  });
});

describe("leaksIn", () => {
  it("finds the value anywhere and the cookie unless filtered", () => {
    const texts = new Map([
      ["clean.json", '"cookie": "__Host-ductus_session=[Filtered]"'],
      ["config.toml", 'Cookie = "__Host-ductus_session=${DUCTUS_ST_SESSION}"'],
      ["value.har", "x secret-value y"],
      ["raw.txt", "set-cookie: __Host-ductus_session=other"],
    ]);
    expect(leaksIn(texts, "__Host-ductus_session=secret-value")).toEqual(["value.har", "raw.txt"]);
  });
});

describe("selfTestProblems", () => {
  type Overrides = Partial<ProbeResult["summary"]> & { exitCode?: number; leaks?: string[] };
  const result = (overrides: Overrides = {}): ProbeResult => ({
    exitCode: overrides.exitCode ?? 1,
    leaks: overrides.leaks ?? [],
    summary: {
      routes: [],
      unchecked: overrides.unchecked ?? [],
      errors: 0,
      scope: overrides.scope ?? [],
      disagreements: overrides.disagreements ?? [
        {
          code: "ST108",
          title: "Response violates schema",
          count: 1,
          operations: ["GET /api/v1/broken"],
        },
      ],
    },
  });
  const seen = [
    "GET /",
    "GET /schemathesis-probe%5C%1B%01",
    "GET /api/v1/good",
    "GET /api/v1/broken",
  ];

  it("passes when only the broken route disagrees and the run stayed in scope", () => {
    expect(selfTestProblems(result(), seen)).toEqual([]);
  });

  it("fails when the broken route is missed or the good one is blamed", () => {
    expect(selfTestProblems(result({ exitCode: 0, disagreements: [] }), seen)).toEqual([
      "Schemathesis je završio s 0 iako ruta odstupa od sheme",
      "neslaganje na /api/v1/broken nije prijavljeno",
    ]);
    const both = [
      {
        code: "ST108",
        title: "t",
        count: 1,
        operations: ["GET /api/v1/broken", "GET /api/v1/good"],
      },
    ];
    expect(selfTestProblems(result({ disagreements: both }), seen)).toEqual([
      "prijavljeno i drugo: GET /api/v1/broken, GET /api/v1/good",
    ]);
  });

  it("fails on any request outside the list, a scope note, an unchecked route or a leak", () => {
    const problems = selfTestProblems(
      result({
        scope: ["request outside scope: method TRACE"],
        unchecked: ["/api/v1/good"],
        leaks: ["izlaz"],
      }),
      [...seen, "POST /api/v1/good", "GET /api/v1/outside"],
    );
    expect(problems).toEqual([
      "bez 2xx: /api/v1/good",
      "request outside scope: method TRACE",
      "poslužitelj je primio i: POST /api/v1/good, GET /api/v1/outside",
      "kolačić u: izlaz",
    ]);
  });
});

describe("stackExitCode", () => {
  const summary = { routes: [], unchecked: [], disagreements: [], errors: 0, scope: [] };

  it("is 0 for a valid run, also when it found disagreements", () => {
    expect(stackExitCode({ leaks: [], summary })).toBe(0);
    const disagreements = [{ code: "ST108", title: "t", count: 1, operations: ["GET /api/v1/x"] }];
    expect(stackExitCode({ leaks: [], summary: { ...summary, disagreements } })).toBe(0);
  });

  it("is 1 when Schemathesis reported run errors", () => {
    expect(stackExitCode({ leaks: [], summary: { ...summary, errors: 3 } })).toBe(1);
  });

  it("is 2 when the run left its scope or leaked the cookie, before run errors", () => {
    expect(
      stackExitCode({ leaks: [], summary: { ...summary, scope: ["outside"], errors: 1 } }),
    ).toBe(2);
    expect(stackExitCode({ leaks: ["izlaz"], summary })).toBe(2);
  });
});

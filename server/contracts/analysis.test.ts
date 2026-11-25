// SRV-V15-UGOVOR: the contract of the stateless statistical analysis. The
// body is closed, the limits of the catalogue are the ones of the schema, the
// answer has no place for a person, and nothing here needs a stored dataset.
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { API_VERSION, ROUTES } from "./index.ts";
import {
  ANALYSIS_IDS,
  ANALYSIS_LIMITS,
  AnalysisCatalogue,
  AnalysisRunInput,
  AnalysisRunResult,
  analysisCatalogueGet,
  analysisRoutes,
  analysisRunsPost,
} from "./routes/index.ts";

const vectors = (id: string) =>
  (
    JSON.parse(readFileSync(new URL(`./vectors/${id}.json`, import.meta.url), "utf8")) as {
      vectors: { name: string; request: { body?: unknown }; response: { body?: unknown } }[];
    }
  ).vectors;

const column = (name: string, kind: "numeric" | "category" = "numeric") => ({ name, kind });
const valid = {
  analysisId: "correlation",
  analysisVersion: "1.0.0",
  variables: ["a", "b"],
  columns: [column("a"), column("b")],
  rows: [
    [1, 2],
    [2, null],
    [3, "x"],
  ],
};

/** Every property name in a schema. */
function names(schema: unknown, into = new Set<string>()): Set<string> {
  if (schema === null || typeof schema !== "object") return into;
  const s = schema as Record<string, unknown>;
  for (const [key, value] of Object.entries((s.properties ?? {}) as object)) {
    into.add(key);
    names(value, into);
  }
  for (const part of ["items", "anyOf", "oneOf", "allOf"] as const) {
    const sub = s[part];
    for (const item of Array.isArray(sub) ? sub : [sub]) names(item, into);
  }
  return into;
}

describe("the two routes", () => {
  it("are in ROUTES, for any signed-in user, and only the POST is guarded and bounded", () => {
    expect(analysisRoutes.map((r) => r.id)).toEqual([
      "analysis.catalogue.get",
      "analysis.runs.post",
    ]);
    for (const r of analysisRoutes) expect(ROUTES).toContain(r);
    expect(analysisCatalogueGet.access).toBe("signed_in");
    expect(analysisRunsPost.access).toBe("signed_in");
    expect(analysisCatalogueGet.path).toBe("/api/v1/analysis/catalogue");
    expect(analysisRunsPost.path).toBe("/api/v1/analysis/runs");
    expect(analysisRunsPost.request.maxBodyBytes).toBe(ANALYSIS_LIMITS.maxBodyBytes);
    expect(analysisRunsPost.errors.map((e) => `${e.status} ${e.code}`)).toEqual(
      expect.arrayContaining([
        "403 origin_missing",
        "413 body_too_large",
        "415 unsupported_media_type",
        "404 not_found",
        "422 invalid_input",
        "422 unknown_analysis_version",
        "503 unavailable",
      ]),
    );
    expect(analysisCatalogueGet.errors.map((e) => `${e.status} ${e.code}`)).toEqual([
      "401 unauthorized",
      "404 not_found",
      "503 unavailable",
    ]);
  });

  it("raise the API to at least 1.135.0 and keep health on API_VERSION", () => {
    const [major, minor] = API_VERSION.split(".").map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(135);
  });
});

describe("the limits", () => {
  it("are the ones the catalogue names, in the schema of the body and in the numbers of the plan", () => {
    expect(ANALYSIS_LIMITS).toEqual({
      maxRows: 500,
      maxColumns: 12,
      maxCellLength: 64,
      maxBodyBytes: 131072,
    });
    const rows = (n: number, cells = 2) => Array.from({ length: n }, () => Array(cells).fill(1));
    expect(Value.Check(AnalysisRunInput, { ...valid, rows: rows(500) })).toBe(true);
    expect(Value.Check(AnalysisRunInput, { ...valid, rows: rows(501) })).toBe(false);
    const wide = Array.from({ length: 13 }, (_, i) => column(`c${i}`));
    expect(Value.Check(AnalysisRunInput, { ...valid, columns: wide.slice(0, 12) })).toBe(true);
    expect(Value.Check(AnalysisRunInput, { ...valid, columns: wide })).toBe(false);
    expect(Value.Check(AnalysisRunInput, { ...valid, rows: [["x".repeat(64), 1]] })).toBe(true);
    expect(Value.Check(AnalysisRunInput, { ...valid, rows: [["x".repeat(65), 1]] })).toBe(false);
  });

  it("make the catalogue answer refuse any other number", () => {
    const answer = vectors("analysis.catalogue.get").find((v) => v.name === "catalogue")!.response
      .body as { limits: Record<string, number> };
    expect(Value.Check(AnalysisCatalogue, answer)).toBe(true);
    expect(
      Value.Check(AnalysisCatalogue, { ...answer, limits: { ...answer.limits, maxRows: 501 } }),
    ).toBe(false);
  });

  it("list exactly the closed set of analyses", () => {
    expect(ANALYSIS_IDS).toEqual(["descriptive", "frequencies", "correlation"]);
    expect(Value.Check(AnalysisRunInput, { ...valid, analysisId: "t_test" })).toBe(false);
  });
});

describe("the body is closed", () => {
  it("accepts a number, a text and a missing cell", () => {
    expect(Value.Check(AnalysisRunInput, valid)).toBe(true);
  });

  it.each([
    ["an unknown field", { ...valid, identity: "x" }],
    [
      "an unknown field in a column",
      { ...valid, columns: [{ ...column("a"), unit: "h" }, column("b")] },
    ],
    ["a version that is not major.minor.patch", { ...valid, analysisVersion: "1.0" }],
    ["no variables", { ...valid, variables: [] }],
    [
      "a column kind outside the two",
      { ...valid, columns: [column("a"), { name: "b", kind: "text" }] },
    ],
    ["an empty column name", { ...valid, columns: [column(""), column("b")] }],
    [
      "a column name over 40 characters",
      { ...valid, columns: [column("n".repeat(41)), column("b")] },
    ],
    ["a cell that is an object", { ...valid, rows: [[{ v: 1 }, 2]] }],
    ["a cell that is true", { ...valid, rows: [[true, 2]] }],
    ["a dataset in an object (the body is flat)", { ...valid, dataset: { columns: [], rows: [] } }],
  ])("refuses %s", (_, body) => {
    expect(Value.Check(AnalysisRunInput, body)).toBe(false);
  });
});

describe("the answer has no place for a person", () => {
  it("names no identity, grade, rank or comparison of persons", () => {
    const all = new Set([
      ...names(AnalysisRunResult),
      ...names(AnalysisCatalogue),
      ...names(AnalysisRunInput),
    ]);
    for (const forbidden of [
      "studentId",
      "authorId",
      "userId",
      "principalId",
      "documentId",
      "workId",
      "courseId",
      "assignmentId",
      "givenName",
      "familyName",
      "email",
      "grade",
      "score",
      "rank",
      "ranking",
      "requestKey",
      "createdAt",
      "computedAt",
    ])
      expect(all.has(forbidden), forbidden).toBe(false);
  });

  it("keeps the vectors inside the schemas, with the three kinds of result", () => {
    const ok = vectors("analysis.runs.post").filter(
      (v) => (v.response.body as { result?: unknown })?.result,
    );
    expect(
      ok.map((v) => (v.response.body as { result: { kind: string } }).result.kind).sort(),
    ).toEqual(["correlation", "correlation", "descriptive", "frequencies"]);
    for (const v of ok) {
      expect(Value.Check(AnalysisRunInput, v.request.body), v.name).toBe(true);
      expect(Value.Check(AnalysisRunResult, v.response.body), v.name).toBe(true);
    }
  });

  it("refuses an answer with a time of calculation or a correlation outside -1..1", () => {
    const answer = vectors("analysis.runs.post").find((v) => v.name === "correlation")!.response
      .body as {
      result: { pairs: { r: number }[] };
    };
    expect(
      Value.Check(AnalysisRunResult, { ...answer, computedAt: "2026-11-25T10:00:00.000Z" }),
    ).toBe(false);
    const pair = answer.result.pairs[0]!;
    expect(
      Value.Check(AnalysisRunResult, {
        ...answer,
        result: { ...answer.result, pairs: [{ ...pair, r: 1.5 }] },
      }),
    ).toBe(false);
    expect(Value.Check(AnalysisRunResult, { ...answer, resultSha256: "not-a-hash" })).toBe(false);
  });
});

describe("the vectors of the error codes", () => {
  it("cover an unknown version as its own 422 and an off function as a 404", () => {
    const codes = vectors("analysis.runs.post").map((v) => v.name);
    expect(codes).toEqual(
      expect.arrayContaining(["unknown-version", "not-found", "unknown-variable", "wrong-kind"]),
    );
    const off = vectors("analysis.catalogue.get").find((v) => v.name === "off")!;
    expect((off.response.body as { code: string }).code).toBe("not_found");
  });
});

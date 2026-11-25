import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-V15-UGOVOR (docs/nalazi/val15-razlika.md §3 in the web repo, Ductus#2055
// c.7163756092, wave 15): the contract of a small, deterministic statistical
// analysis done in the request. The dataset (columns and rows, flat in the
// body: the generator refuses an object that holds arrays, so the plan's
// dataset.columns and dataset.rows are columns and rows) travels in the body and is not
// kept: no table, no stored run, no record of its content. Same
// analysisVersion plus same dataset (same rows, same column order) gives the
// same result byte for byte, and the same datasetSha256 and resultSha256.
// Contract only: the calculation (SRV-V15-IZVRSITELJ) and the HTTP adapter
// behind a switch that is off by default (SRV-V15-HTTP) follow. While the
// switch is off both routes answer 404 not_found as if they did not exist.
// The contract holds no identity of a person and no comparison of persons.

/** The limits of a dataset, the same in the catalogue answer and in the domain. */
export const ANALYSIS_LIMITS = {
  maxRows: 500,
  maxColumns: 12,
  maxCellLength: 64,
  maxBodyBytes: 131_072,
} as const;

/** The longest column name. */
export const ANALYSIS_MAX_COLUMN_NAME = 40;
/** The most distinct values a frequency table lists; the rest is otherCount. */
export const ANALYSIS_MAX_FREQUENCY_VALUES = 50;

/** The closed list of analyses. */
export const ANALYSIS_IDS = ["descriptive", "frequencies", "correlation"] as const;
export type AnalysisId = (typeof ANALYSIS_IDS)[number];

const AnalysisIdSchema = Type.Union(ANALYSIS_IDS.map((id) => Type.Literal(id)));
const Version = Type.String({
  pattern: "^(?:0|[1-9]\\d{0,5})\\.(?:0|[1-9]\\d{0,5})\\.(?:0|[1-9]\\d{0,5})$",
});
const Sha256 = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Count = Type.Integer({ minimum: 0, maximum: ANALYSIS_LIMITS.maxRows });
/** A number rounded to 6 decimals by the server, or null where it is not defined. */
const Measure = Type.Union([Type.Number(), Type.Null()]);
const ColumnName = Type.String({ minLength: 1, maxLength: ANALYSIS_MAX_COLUMN_NAME });

export const AnalysisCatalogue = closed({
  limits: closed({
    maxRows: Type.Literal(ANALYSIS_LIMITS.maxRows),
    maxColumns: Type.Literal(ANALYSIS_LIMITS.maxColumns),
    maxCellLength: Type.Literal(ANALYSIS_LIMITS.maxCellLength),
    maxBodyBytes: Type.Literal(ANALYSIS_LIMITS.maxBodyBytes),
  }),
  analyses: Type.Array(
    closed({
      id: AnalysisIdSchema,
      version: Version,
      variables: closed({
        kind: Type.Union([Type.Literal("numeric"), Type.Literal("any")]),
        min: Type.Integer({ minimum: 1, maximum: ANALYSIS_LIMITS.maxColumns }),
        max: Type.Integer({ minimum: 1, maximum: ANALYSIS_LIMITS.maxColumns }),
      }),
    }),
    { maxItems: ANALYSIS_IDS.length },
  ),
});

const Cell = Type.Union([
  Type.Number(),
  Type.String({ maxLength: ANALYSIS_LIMITS.maxCellLength }),
  Type.Null(),
]);

export const AnalysisRunInput = closed({
  analysisId: AnalysisIdSchema,
  analysisVersion: Version,
  variables: Type.Array(ColumnName, {
    minItems: 1,
    maxItems: ANALYSIS_LIMITS.maxColumns,
  }),
  columns: Type.Array(
    closed({
      name: ColumnName,
      kind: Type.Union([Type.Literal("numeric"), Type.Literal("category")]),
    }),
    { minItems: 1, maxItems: ANALYSIS_LIMITS.maxColumns },
  ),
  rows: Type.Array(Type.Array(Cell, { minItems: 1, maxItems: ANALYSIS_LIMITS.maxColumns }), {
    maxItems: ANALYSIS_LIMITS.maxRows,
  }),
});

const Descriptive = closed({
  kind: Type.Literal("descriptive"),
  columns: Type.Array(
    closed({
      name: ColumnName,
      n: Count,
      missing: Count,
      mean: Measure,
      sd: Measure,
      median: Measure,
      min: Measure,
      q1: Measure,
      q3: Measure,
      max: Measure,
    }),
    { maxItems: ANALYSIS_LIMITS.maxColumns },
  ),
});

const Frequencies = closed({
  kind: Type.Literal("frequencies"),
  columns: Type.Array(
    closed({
      name: ColumnName,
      n: Count,
      missing: Count,
      values: Type.Array(
        closed({
          value: Type.String({ maxLength: ANALYSIS_LIMITS.maxCellLength }),
          count: Count,
          share: Type.Number({ minimum: 0, maximum: 1 }),
        }),
        { maxItems: ANALYSIS_MAX_FREQUENCY_VALUES },
      ),
      otherCount: Count,
    }),
    { maxItems: ANALYSIS_LIMITS.maxColumns },
  ),
});

const Correlation = closed({
  kind: Type.Literal("correlation"),
  pairs: Type.Array(
    closed({
      a: ColumnName,
      b: ColumnName,
      n: Count,
      r: Type.Union([Type.Number({ minimum: -1, maximum: 1 }), Type.Null()]),
    }),
    { maxItems: (ANALYSIS_LIMITS.maxColumns * (ANALYSIS_LIMITS.maxColumns - 1)) / 2 },
  ),
});

export const AnalysisRunResult = closed({
  analysisId: AnalysisIdSchema,
  analysisVersion: Version,
  datasetSha256: Sha256,
  resultSha256: Sha256,
  rowCount: Count,
  result: Type.Union([Descriptive, Frequencies, Correlation]),
});

export const analysisCatalogueGet = defineRoute({
  id: "analysis.catalogue.get",
  method: "GET",
  path: "/api/v1/analysis/catalogue",
  inventory: "app/api/analysis/catalogue/route.ts",
  access: "signed_in",
  summary:
    "The analyses the server can calculate, each with its id, its version and which columns it takes (numeric only, or any), and the limits of a dataset: rows, columns, characters in a category cell and bytes of a request. Titles and descriptions are not in the answer; the client names the ids. While the function is off the answer is 404 not_found.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the analyses and the limits",
      body: AnalysisCatalogue,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const analysisRunsPost = defineRoute({
  id: "analysis.runs.post",
  method: "POST",
  path: "/api/v1/analysis/runs",
  inventory: "app/api/analysis/runs/route.ts",
  access: "signed_in",
  summary:
    "Calculates one analysis over the dataset in the body: descriptive statistics (n, missing, mean, sample standard deviation, median, minimum, quartiles, maximum), a frequency table, or Pearson correlation with pairwise deletion of missing cells. Nothing is stored and the dataset and the result are not written to any record. Numbers are rounded to 6 decimals; a value that is not defined is null. The same analysisVersion over the same dataset (same rows, same column order) gives the same result, datasetSha256 and resultSha256, byte for byte; the order of the rows does not change the result. A version the server no longer holds is 422 unknown_analysis_version. A dataset outside the limits of the catalogue, a repeated column or variable name, a row with a different number of cells than there are columns, an unknown variable or a column of the wrong kind is 422 invalid_input. While the function is off the answer is 404 not_found.",
  request: {
    contentType: "application/json",
    maxBodyBytes: ANALYSIS_LIMITS.maxBodyBytes,
    body: AnalysisRunInput,
  },
  responses: [
    {
      status: 200,
      description: "the result and the fingerprints",
      body: AnalysisRunResult,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(422, "unknown_analysis_version"),
    error(503, "unavailable"),
  ],
});

export const analysisRoutes = [analysisCatalogueGet, analysisRunsPost] as const;

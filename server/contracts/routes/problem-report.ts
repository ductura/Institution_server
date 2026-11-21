import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const DISALLOWED = "\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u202a-\\u202e\\u2066-\\u2069";
const INVISIBLE =
  "\\u0009-\\u000d\\u0020\\u0085\\u00a0\\u1680\\u2000-\\u200d\\u2028\\u2029\\u202f\\u205f\\u2060\\u3000\\ufeff";
const APP_VERSION = `^(?:(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})\\.(?:0|[1-9][0-9]{0,3})(?:\\+[0-9a-f]{7,40})?|[0-9a-f]{7,40})${END}`;

export const ProblemReportInput = closed({
  category: Type.Union([
    Type.Literal("technical"),
    Type.Literal("account"),
    Type.Literal("course"),
  ]),
  description: Type.String({
    pattern: `^(?=[\\s\\S]*[^${INVISIBLE}])(?:${CODE_POINT}|[^${DISALLOWED}\\uD800-\\uDFFF]){1,2000}${END}`,
  }),
  appVersion: Type.String({ pattern: APP_VERSION }),
});

export const problemReportsPost = defineRoute({
  id: "support.problem-reports.post",
  method: "POST",
  path: "/api/v1/problem-reports",
  inventory: "app/api/problem-reports/route.ts",
  access: "signed_in",
  summary:
    "Submit a problem report with up to 2000 Unicode code points and receive a reference. The limit is five reports per account in a sliding hour, shared with the support route.",
  request: { contentType: "application/json", maxBodyBytes: 32 * 1024, body: ProblemReportInput },
  responses: [
    {
      status: 201,
      description: "recorded; the reference the user quotes",
      body: closed({ reference: Type.String({ pattern: `^PR-[0-9A-F]{10}${END}` }) }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(429, "too_many_reports"),
    error(503, "unavailable"),
  ],
});

// The stateless analysis on the dev fake server (SRV-V15-UGOVOR): a small
// calculation of the three analyses over invented data, nothing kept. The real
// numbers are the domain's (SRV-V15-IZVRSITELJ); this fake only has the shape.
import { createHash } from "node:crypto";

import type { Operations } from "../../contracts/index.ts";
import type { Handlers } from "./server.ts";

type Run = Operations["analysis.runs.post"]["body"];
type Result = Operations["analysis.runs.post"]["success"]["body"];

const round = (x: number) => Math.round(x * 1e6) / 1e6;
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function numbers(body: Run, name: string): (number | null)[] {
  const at = body.columns.findIndex((c) => c.name === name);
  return body.rows.map((row) => (typeof row[at] === "number" ? (row[at] as number) : null));
}

const quantile = (sorted: number[], q: number) => {
  const pos = (sorted.length - 1) * q;
  const low = Math.floor(pos);
  return sorted[low]! + (pos - low) * ((sorted[low + 1] ?? sorted[low]!) - sorted[low]!);
};

export const ANALYSIS_HANDLERS: Handlers = {
  "analysis.catalogue.get": ({ account }) =>
    account === null
      ? { error: "unauthorized" }
      : {
          status: 200,
          body: {
            limits: { maxRows: 500, maxColumns: 12, maxCellLength: 64, maxBodyBytes: 131072 },
            analyses: [
              {
                id: "descriptive",
                version: "1.0.0",
                variables: { kind: "numeric", min: 1, max: 12 },
              },
              { id: "frequencies", version: "1.0.0", variables: { kind: "any", min: 1, max: 12 } },
              {
                id: "correlation",
                version: "1.0.0",
                variables: { kind: "numeric", min: 2, max: 12 },
              },
            ],
          },
        },
  "analysis.runs.post": ({ account, body }) => {
    if (account === null) return { error: "unauthorized" };
    if (body.analysisVersion !== "1.0.0") return { error: "unknown_analysis_version" };
    const names = body.columns.map((c) => c.name);
    if (
      new Set(names).size !== names.length ||
      new Set(body.variables).size !== body.variables.length ||
      body.rows.some((row) => row.length !== names.length) ||
      body.variables.some((v) => !names.includes(v)) ||
      (body.analysisId !== "frequencies" &&
        body.variables.some((v) => body.columns.find((c) => c.name === v)?.kind !== "numeric")) ||
      (body.analysisId === "correlation" && body.variables.length < 2)
    )
      return { error: "invalid_input" };
    let result: Result["result"];
    if (body.analysisId === "descriptive") {
      result = {
        kind: "descriptive",
        columns: body.variables.map((name) => {
          const all = numbers(body, name);
          const xs = all.filter((x): x is number => x !== null).sort((a, b) => a - b);
          const n = xs.length;
          const mean = n === 0 ? null : xs.reduce((s, x) => s + x, 0) / n;
          const sd =
            n < 2 || mean === null
              ? null
              : Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
          return {
            name,
            n,
            missing: all.length - n,
            mean: mean === null ? null : round(mean),
            sd: sd === null ? null : round(sd),
            median: n === 0 ? null : round(quantile(xs, 0.5)),
            min: n === 0 ? null : xs[0]!,
            q1: n === 0 ? null : round(quantile(xs, 0.25)),
            q3: n === 0 ? null : round(quantile(xs, 0.75)),
            max: n === 0 ? null : xs[n - 1]!,
          };
        }),
      };
    } else if (body.analysisId === "frequencies") {
      result = {
        kind: "frequencies",
        columns: body.variables.map((name) => {
          const at = names.indexOf(name);
          const cells = body.rows
            .map((row) => row[at])
            .filter((c) => c !== null && c !== undefined);
          const counts = new Map<string, number>();
          for (const cell of cells) counts.set(String(cell), (counts.get(String(cell)) ?? 0) + 1);
          const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "hr"));
          return {
            name,
            n: cells.length,
            missing: body.rows.length - cells.length,
            values: sorted
              .slice(0, 50)
              .map(([value, count]) => ({ value, count, share: round(count / cells.length) })),
            otherCount: sorted.slice(50).reduce((s, [, count]) => s + count, 0),
          };
        }),
      };
    } else {
      const pairs: { a: string; b: string; n: number; r: number | null }[] = [];
      body.variables.forEach((a, i) =>
        body.variables.slice(i + 1).forEach((b) => {
          const xa = numbers(body, a);
          const xb = numbers(body, b);
          const both = xa.flatMap((x, k) =>
            x !== null && xb[k] !== null ? [[x, xb[k]!] as const] : [],
          );
          const n = both.length;
          let r: number | null = null;
          if (n >= 3) {
            const ma = both.reduce((s, p) => s + p[0], 0) / n;
            const mb = both.reduce((s, p) => s + p[1], 0) / n;
            const sab = both.reduce((s, p) => s + (p[0] - ma) * (p[1] - mb), 0);
            const saa = both.reduce((s, p) => s + (p[0] - ma) ** 2, 0);
            const sbb = both.reduce((s, p) => s + (p[1] - mb) ** 2, 0);
            r =
              saa === 0 || sbb === 0
                ? null
                : round(Math.max(-1, Math.min(1, sab / Math.sqrt(saa * sbb))));
          }
          pairs.push({ a, b, n, r });
        }),
      );
      result = { kind: "correlation", pairs };
    }
    return {
      status: 200,
      body: {
        analysisId: body.analysisId,
        analysisVersion: body.analysisVersion,
        datasetSha256: sha({ columns: body.columns, rows: body.rows, variables: body.variables }),
        resultSha256: sha(result),
        rowCount: body.rows.length,
        result,
      },
    };
  },
};

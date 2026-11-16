// S-1K.4-b part 2 (DAN-834-2) against the real logs database (CI:
// 127.0.0.1:54330, migrated by scripts/db/migrate-locked.ts --database logs):
// the metric_sample writer as ductus_logs_writer writes a round, a round with
// one sample off the table's lists writes nothing, and a logs database that
// refuses the connection only skips the round. Every case that writes runs in
// a transaction that is rolled back. With no database it fails, it never skips.
import { createServer } from "node:net";

import pg from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  createMetricSampleWriter,
  createMetricsCollector,
  type MetricSample,
} from "../../server/metrics/index.ts";
import { requireLoopbackDatabaseUrl } from "./loopback-database-url.ts";

const LOGS_URL = requireLoopbackDatabaseUrl(
  process.env.LOGS_DATABASE_URL ??
    "postgres://ductus:ductus-logs-local-only@127.0.0.1:54330/ductus_logs",
  "The metric sample test runs only against a loopback logs database (LOGS_DATABASE_URL).",
);
const logs = new pg.Pool({ connectionString: LOGS_URL, max: 1 });
afterAll(() => logs.end());

type Row = { metric: string; value: string; labels: unknown };

/** Writes `samples` as the writer in a rolled-back transaction; the outcome and the rows it left. */
async function writeAsWriter(samples: readonly MetricSample[]) {
  const client = await logs.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE ductus_logs_reader");
    const before = (
      await client.query<{ id: string }>(
        "SELECT coalesce(max(id), 0) AS id FROM public.metric_sample",
      )
    ).rows[0]!.id;
    await client.query("SET LOCAL ROLE ductus_logs_writer");
    await client.query("SAVEPOINT round");
    const write = createMetricSampleWriter({ store: client });
    const written = await write(samples).then(
      () => true,
      () => false,
    );
    if (!written) await client.query("ROLLBACK TO SAVEPOINT round");
    await client.query("SET LOCAL ROLE ductus_logs_reader");
    const rows = (
      await client.query<Row>(
        "SELECT metric, value, labels FROM public.metric_sample WHERE id > $1 ORDER BY id",
        [before],
      )
    ).rows;
    return { written, rows };
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

describe("metric_sample writer on the logs database", () => {
  it("writes a round as ductus_logs_writer; missing labels become {}", async () => {
    const result = await writeAsWriter([
      { metric: "database_connections", value: 4, labels: { database: "logs" } },
      { metric: "error_count", value: 0, labels: { service: "storage" } },
      { metric: "request_count", value: 2 ** 53 - 1 },
    ]);
    expect(result).toEqual({
      written: true,
      rows: [
        { metric: "database_connections", value: "4", labels: { database: "logs" } },
        { metric: "error_count", value: "0", labels: { service: "storage" } },
        { metric: "request_count", value: "9007199254740991", labels: {} },
      ],
    });
  });

  // The lists themselves (NBSP, CRLF, tab, DEL, __proto__, unlisted keys) are
  // checked by db/logs/tests/030-metric-sample.sql; here only what the writer
  // adds: one statement per round and the cast of the recordset.
  it.each<[string, unknown]>([
    ["an unlisted metric", { metric: "cpu", value: 1 }],
    ["a fractional value", { metric: "request_count", value: 1.5 }],
    ["a value past 2^53 - 1", { metric: "request_count", value: 2 ** 53 }],
    [
      "an inherited-name label key",
      { metric: "request_count", value: 1, labels: JSON.parse('{"__proto__":"main"}') },
    ],
  ])("refuses the whole round with %s next to a good sample", async (_, bad) => {
    const result = await writeAsWriter([
      { metric: "request_count", value: 1 },
      bad as MetricSample,
    ]);
    expect(result).toEqual({ written: false, rows: [] });
  });
});

describe("a logs database that refuses the connection", () => {
  it("skips each round with write_failed and the collector runs on", async () => {
    // A port that was just free: the connection is refused, as a database that is down.
    const probe = createServer().listen(0, "127.0.0.1");
    await new Promise((resolve) => probe.once("listening", resolve));
    const { port } = probe.address() as { port: number };
    await new Promise((resolve) => probe.close(resolve));
    const down = new pg.Pool({ host: "127.0.0.1", port, user: "ductus", database: "ductus_logs" });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const collect = vi.fn((): MetricSample[] => [{ metric: "request_count", value: 1 }]);
    const onSkip = vi.fn();
    const collector = createMetricsCollector({
      intervalMs: 100,
      collect,
      write: createMetricSampleWriter({ store: down }),
      onSkip,
    });
    try {
      collector.start();
      await vi.waitFor(() => expect(onSkip.mock.calls.length).toBeGreaterThanOrEqual(3), {
        timeout: 5_000,
      });
      await collector.stop();
      expect(new Set(onSkip.mock.calls.map((call) => call.join()))).toEqual(
        new Set(["write_failed"]),
      );
      expect(collect.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      await collector.stop();
      process.off("unhandledRejection", unhandled);
      await down.end();
    }
  });
});

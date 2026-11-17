import { beforeEach, describe, expect, it, vi } from "vitest";

// DAN-834-5a (QA on 869426c): metricSampleStore writes through the logs pool
// of the registry, refuses without LOGS_DATABASE_URL and after closePools,
// and never opens a pool to refuse. The driver is a fake; the URLs are
// invented and never dialled.
type FakePool = {
  config: { connectionString?: string; application_name?: string };
  query: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
};
const pools = vi.hoisted(() => [] as FakePool[]);
vi.mock("pg", () => {
  class Pool {
    query = vi.fn(async () => ({ rowCount: 1 }));
    end = vi.fn(async () => undefined);
    constructor(public config: FakePool["config"]) {
      pools.push(this);
    }
    on(): this {
      return this;
    }
  }
  return { default: Object.fromEntries([["Pool", Pool]]) };
});

import { createMetricSampleWriter, METRIC_SAMPLE_INSERT } from "../metrics/index.ts";
import { closePools, metricSampleStore } from "./index.ts";

const LOGS_URL = "postgres://logs:invented-5a17@logs.invalid:5432/ductus_logs";
const SAMPLE = { metric: "database_connections", value: 1, labels: { database: "main" } } as const;

beforeEach(() => {
  vi.unstubAllEnvs();
});

describe("metricSampleStore", () => {
  it("without LOGS_DATABASE_URL: rejects by variable name and opens no pool", async () => {
    vi.stubEnv("LOGS_DATABASE_URL", undefined);
    const call = metricSampleStore.query("SELECT 1", []);
    await expect(call).rejects.toThrow("LOGS_DATABASE_URL is not set");
    await expect(createMetricSampleWriter({ store: metricSampleStore })([SAMPLE])).rejects.toThrow(
      "metric samples not written",
    );
    expect(pools).toHaveLength(0);
  });

  it("writes one round through the logs pool, then refuses after closePools", async () => {
    vi.stubEnv("LOGS_DATABASE_URL", LOGS_URL);
    await createMetricSampleWriter({ store: metricSampleStore })([SAMPLE]);
    expect(pools).toHaveLength(1);
    const [pool] = pools;
    expect(pool?.config).toMatchObject({
      connectionString: LOGS_URL,
      application_name: "ductura-logs",
    });
    expect(pool?.query.mock.calls).toEqual([[METRIC_SAMPLE_INSERT, [JSON.stringify([SAMPLE])]]]);

    await closePools();
    expect(pool?.end).toHaveBeenCalledTimes(1);
    await expect(metricSampleStore.query("SELECT 1", [])).rejects.toThrow(
      /database pools are closed/u,
    );
    expect(pools).toHaveLength(1);
    expect(pool?.query).toHaveBeenCalledTimes(1);
  });
});

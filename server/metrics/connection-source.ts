// The database connection source (S-1K.4-b part 4a, DAN-834-4a; contract
// Ductus#1836 c.6931241645): a `collect` part for the metrics collector that
// turns the registry's health report into database_connections samples, 1 for
// a database that answers and 0 for one that does not. It imports nothing
// (metrics may import only settings, docs/server-map.md §2): the assembler
// hands it `health` (server/database databaseHealth, 834-5). A sample is made
// of constants only; the report is compared with two words and never copied,
// so a connection string, a user or an error text has nowhere to go.
import type { MetricSample } from "./sample-writer.ts";

type DatabaseLabel = "main" | "logs" | "legal";

const DATABASES: readonly DatabaseLabel[] = ["main", "logs", "legal"];
/** The words of registry.health() this source reads; the rest is "not available". */
const AVAILABLE = "ok";
const NOT_SET_UP = "nije_konfigurirano";

const sample = (database: DatabaseLabel, value: 0 | 1): MetricSample =>
  Object.freeze({
    metric: "database_connections",
    value,
    labels: Object.freeze({ database }),
  });

/** An own data property's value; a getter, an inherited key or a trap gives undefined. */
function ownValue(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null || Array.isArray(target)) return undefined;
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

function samplesOf(report: unknown): readonly MetricSample[] {
  try {
    const samples: MetricSample[] = [];
    for (const database of DATABASES) {
      const state = ownValue(report, database);
      if (state === NOT_SET_UP) continue;
      samples.push(sample(database, state === AVAILABLE ? 1 : 0));
    }
    return Object.freeze(samples);
  } catch {
    return unknownState();
  }
}

/** Availability cannot be confirmed: every database counts as not available. */
const unknownState = (): readonly MetricSample[] =>
  Object.freeze(DATABASES.map((database) => sample(database, 0)));

/** A `collect` part over `health`; its promise never rejects. */
export function createConnectionSource(
  health: () => unknown,
): () => Promise<readonly MetricSample[]> {
  if (typeof health !== "function") throw new RangeError("health must be a function");
  return () =>
    // A throwing health, a rejection or a throwing `then` all settle as unknown.
    Promise.resolve().then(health).then(samplesOf, unknownState);
}

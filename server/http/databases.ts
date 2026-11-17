// The databases the server reaches, by name. Only server/database opens a
// connection, through its registry (S-1F-a, DAN-783), and only on first use,
// so building this object opens nothing. The logs and legal databases have no
// caller yet; their state is already in health().
import {
  actorReader,
  type ActorReader,
  closePools,
  databaseHealth,
  type HealthReport,
  metricSampleStore,
  withActor,
  type WithActor,
  workOpener,
  type WorkOpener,
} from "../database/index.ts";
import type { MetricSampleStore } from "../metrics/index.ts";

export type Databases = {
  readonly main: {
    readonly withActor: WithActor;
    readonly actorReader: ActorReader;
    readonly workOpener: WorkOpener;
  };
  /** The state of main, logs and legal, each apart; the input of readiness (S-1M-a). */
  health(): Promise<HealthReport>;
  /** The metric_sample port over the logs database (DAN-834-5a); it opens on first write. */
  readonly metricSamples: MetricSampleStore;
  /** Ends every open pool, on shutdown; each database of the registry closes here too. */
  close(): Promise<void>;
};

export function createDatabases(): Databases {
  return {
    main: { withActor, actorReader, workOpener },
    health: databaseHealth,
    metricSamples: metricSampleStore,
    close: closePools,
  };
}

// The databases the server reaches, by name. Only server/database opens a
// connection, through its registry (S-1F-a, DAN-783), and only on first use,
// so building this object opens nothing. The logs and legal databases have no
// caller yet; their state is already in health().
import {
  actorReader,
  type ActorReader,
  closePools,
  createSettingsWriter,
  createWebAuthnCredentials,
  databaseHealth,
  type HealthReport,
  metricSampleStore,
  type SettingsWriter,
  type WebAuthnCredentials,
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
    /** settings.set_value over the same withActor (DAN-826-2b; PUT /api/v1/settings/values). */
    readonly settingsWriter: SettingsWriter;
    /** The WebAuthn credential RPCs over the same withActor (DAN-840-3b; the routes of 840-3c and 3d). */
    readonly webauthnCredentials: WebAuthnCredentials;
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
    main: {
      withActor,
      actorReader,
      workOpener,
      settingsWriter: createSettingsWriter(withActor),
      webauthnCredentials: createWebAuthnCredentials(withActor),
    },
    health: databaseHealth,
    metricSamples: metricSampleStore,
    close: closePools,
  };
}

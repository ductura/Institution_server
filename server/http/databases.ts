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
  withActor,
  type WithActor,
} from "../database/index.ts";

export type Databases = {
  readonly main: { readonly withActor: WithActor; readonly actorReader: ActorReader };
  /** The state of main, logs and legal, each apart; the input of readiness (S-1M-a). */
  health(): Promise<HealthReport>;
  /** Ends every open pool, on shutdown; each database of the registry closes here too. */
  close(): Promise<void>;
};

export function createDatabases(): Databases {
  return { main: { withActor, actorReader }, health: databaseHealth, close: closePools };
}

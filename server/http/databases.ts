// The databases the server reaches, by name. Only server/database opens a
// connection, and only on first use (withActor is lazy), so building the
// registry opens nothing. S-1F-a adds the logs and legal databases here.
import {
  actorReader,
  type ActorReader,
  closePools,
  withActor,
  type WithActor,
} from "../database/index.ts";

export type Databases = {
  readonly main: { readonly withActor: WithActor; readonly actorReader: ActorReader };
  /** Ends every open pool, on shutdown; each database added here closes here too. */
  close(): Promise<void>;
};

export function createDatabases(): Databases {
  return { main: { withActor, actorReader }, close: closePools };
}

// The databases the server reaches, by name. Only server/database opens a
// connection, and only on first use (withActor is lazy), so building the
// registry opens nothing. S-1F-a adds the logs and legal databases here.
import { actorReader, type ActorReader, withActor, type WithActor } from "../database/index.ts";

export type Databases = {
  readonly main: { readonly withActor: WithActor; readonly actorReader: ActorReader };
};

export function createDatabases(): Databases {
  return { main: { withActor, actorReader } };
}

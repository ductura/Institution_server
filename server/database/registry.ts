// The registry of database connections (S-1F-a, DAN-783): the one place in
// the server that makes a pool. Each database has its own pool, its own limit
// and its own waits, so a database that is down, frozen or out of
// connections fails only the calls to that database; the others answer as
// before. migration-lock.ts (one client of the migrator) and the
// plain-label-check.ts command are the only other places that connect
// (registry-boundary.test.ts).
//
// Nothing here logs or throws a connection string, a user or a password: a
// message of the registry names the database or the variable, and at most an
// error code. An error of the driver itself (a failed query) may name the host
// or the user, so callers log only its code or name, never its message.
import pg from "pg";

/** The databases whose state the registry reports. */
export type DatabaseName = "main" | "logs" | "legal";
/** A pool: one per database, and `auth`, the second login to the main database. */
export type PoolName = DatabaseName | "auth";

/**
 * State of one database, in the words of CapabilityStatus in the API contract
 * (server/contracts/routes/platform.ts); server/http/databases.test.ts keeps
 * the two lists equal.
 */
export const DATABASE_HEALTH_WORDS = ["ok", "nedostupno", "nije_konfigurirano"] as const;
export type DatabaseHealth = (typeof DATABASE_HEALTH_WORDS)[number];
export type HealthReport = Readonly<Record<DatabaseName, DatabaseHealth>>;

type PoolSpec = {
  /** The environment variable with the connection string; never a default. */
  readonly variable: string;
  /** Connections of this pool in one process. */
  readonly max: number;
};

/**
 * The closed list of pools. A new database is a new line here and in
 * DatabaseName; an unknown name is an error, never a default. The main and
 * auth limits are those of S-0.17; logs and legal are small, because each
 * request writes or reads them at most once.
 */
export const POOLS: Readonly<Record<PoolName, PoolSpec>> = Object.freeze({
  main: { variable: "APP_DATABASE_URL", max: 10 },
  auth: { variable: "AUTH_DATABASE_URL", max: 2 },
  logs: { variable: "LOGS_DATABASE_URL", max: 4 },
  legal: { variable: "LEGAL_DATABASE_URL", max: 2 },
});
const DATABASES: readonly DatabaseName[] = ["main", "logs", "legal"];

/** Longest wait for the state of one database; past it the database is `nedostupno`. */
export const HEALTH_TIMEOUT_MS = 2_000;

/**
 * Longest wait for one pool to end on shutdown; past it the pool counts as not
 * closed and close() settles anyway. It is shorter than the shutdown grace
 * (SHUTDOWN_GRACE_MS, 8 s), so a pool the driver cannot end (a connection
 * stuck half made) does not hold the exit until the deadline.
 */
export const CLOSE_TIMEOUT_MS = 5_000;

/** The pool settings of `name` without the connection string, which the registry adds. */
export type PoolSettings = (connectionString: string, name: PoolName) => pg.PoolConfig;
/** What the registry itself uses of a pool. */
type Pool = {
  query(config: { text: string; query_timeout: number }): Promise<unknown>;
  end(): Promise<void>;
};

export type RegistryOptions<P extends Pool> = {
  /** Settings of every pool (index.ts: appPoolConfig); the registry sets max from POOLS. */
  readonly settings: PoolSettings;
  /** Makes the pool; only unit tests pass a fake. The default is the driver's pool. */
  readonly createPool?: (config: pg.PoolConfig) => P;
};

export type Registry<P extends Pool = pg.Pool> = {
  /** The pool of `name`, made on first use. Throws when it is not configured or closed. */
  pool(name: PoolName): P;
  /** The state of every database, each checked on its own and at the same time. */
  health(): Promise<HealthReport>;
  /** Ends the pools made so far, all of them even when one fails; then every pool() refuses. */
  close(): Promise<void>;
};

/**
 * Keeps a connection that fails from taking the process down. The server may
 * close a connection at any time: the idle-in-transaction limit above, an
 * administrator, a restart. The driver reports that as an `error` event on
 * the client, and an event without a listener is an uncaught exception. The
 * pool listens only while a client is idle, so each client gets a listener
 * for its whole life, borrowed or not.
 *
 * The listener only records. A borrowed client that failed rejects its next
 * statement, so withActor fails and hands it back as broken, and the pool
 * drops it. Only the error code is logged: never a message, a statement, a
 * parameter or a token.
 */
export function handleConnectionErrors<P extends pg.Pool>(pool: P, label?: string): P {
  // The label is the pool's application_name (ductura-<name>), never its URL.
  const prefix = label === undefined ? [] : [label];
  pool.on("connect", (client) => {
    client.on("error", (error: Error & { code?: string }) => {
      console.error("database connection failed", ...prefix, error.code ?? error.name);
    });
  });
  // The pool repeats the failure of an idle client as its own `error` event,
  // already logged above. Without a listener that event would throw.
  pool.on("error", () => {});
  return pool;
}

/** Raised when the registry is closed; the message is the one of S-1B-c. */
export const CLOSED_MESSAGE = "database pools are closed";

function isPoolName(name: string): name is PoolName {
  return Object.hasOwn(POOLS, name);
}

const POSTGRES = new Set(["postgres:", "postgresql:"]);
const isPort = (text: string): boolean => /^[1-9]\d{0,4}$/u.test(text) && Number(text) <= 65_535;

// Settles `work` within `ms`, or rejects; a timer never keeps the process up.
async function within<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("timed out")), ms);
    timer.unref();
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

// The connection string of `spec`, or the reason there is none. The text is
// tested with URL.canParse, because the error of `new URL` carries the input,
// password and all. Anything but a postgres URL is refused as well: the
// driver would read another scheme in its own way. So is a value with spaces
// around it (URL.canParse trims, the driver then dials another host) and a
// `port` parameter that is not a port (the driver throws while connecting and
// leaves a client its pool can never end).
function connectionString(
  env: Readonly<Record<string, string | undefined>>,
  spec: PoolSpec,
): string | Error {
  const value = env[spec.variable];
  if (value === undefined || value.trim() === "") return new Error(`${spec.variable} is not set`);
  if (value !== value.trim() || !URL.canParse(value)) {
    return new Error(`${spec.variable} is not a URL`);
  }
  const parsed = new URL(value);
  if (!POSTGRES.has(parsed.protocol)) return new Error(`${spec.variable} is not a postgres URL`);
  if (!parsed.searchParams.getAll("port").every(isPort)) {
    return new Error(`${spec.variable} has an invalid port`);
  }
  return value;
}

// Settles with "ok" when `check` does within the limit, else "nedostupno".
// The error itself is never read: its message may name a host or a user.
async function probe(check: () => Promise<unknown>): Promise<DatabaseHealth> {
  return within(check(), HEALTH_TIMEOUT_MS).then(
    (): DatabaseHealth => "ok",
    (): DatabaseHealth => "nedostupno",
  );
}

/**
 * A registry over `env`, read on each first use, so a variable set after the
 * registry was made is seen. Making it opens nothing.
 */
export function createRegistry<P extends Pool = pg.Pool>(
  env: Readonly<Record<string, string | undefined>>,
  options: RegistryOptions<P>,
): Registry<P> {
  const createPool =
    options.createPool ??
    ((config: pg.PoolConfig) =>
      handleConnectionErrors(new pg.Pool(config), config.application_name) as unknown as P);
  const pools = new Map<PoolName, P>();
  let closed = false;
  let closing: Promise<void> | undefined;

  const pool = (name: PoolName): P => {
    if (closed) throw new Error(CLOSED_MESSAGE);
    if (!isPoolName(name)) throw new Error("unknown database pool");
    const open = pools.get(name);
    if (open) return open;
    const url = connectionString(env, POOLS[name]);
    if (url instanceof Error) throw url;
    const made = createPool({ ...options.settings(url, name), max: POOLS[name].max });
    pools.set(name, made);
    return made;
  };

  const stateOf = async (name: DatabaseName): Promise<DatabaseHealth> => {
    if (closed) return "nedostupno";
    if (connectionString(env, POOLS[name]) instanceof Error) return "nije_konfigurirano";
    // The statement has the same limit as the wait, so a check given up on
    // does not keep its connection for the pool's longer query limit.
    return probe(async () =>
      pool(name).query({ text: "SELECT 1", query_timeout: HEALTH_TIMEOUT_MS }),
    );
  };

  return {
    pool,
    async health() {
      const states = await Promise.all(DATABASES.map(stateOf));
      return Object.freeze(
        Object.fromEntries(DATABASES.map((name, at) => [name, states[at]])),
      ) as HealthReport;
    },
    // A second call, also one made while the first is running, gets the same promise.
    close() {
      closed = true;
      closing ??= (async () => {
        const open = [...pools.values()];
        const ended = await Promise.allSettled(
          open.map(async (made) => within(made.end(), CLOSE_TIMEOUT_MS)),
        );
        const failed = ended.filter((result) => result.status === "rejected").length;
        if (failed > 0) throw new Error(`${failed} database pool(s) did not close`);
      })();
      return closing;
    },
  };
}

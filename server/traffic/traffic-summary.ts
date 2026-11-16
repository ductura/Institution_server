// The traffic summary (DAN-836-1, contract Ductus#1836): sums of
// traffic.request records by route template and status over a window of
// minutes, for the operator route of DAN-836-2. It reads only event,
// fields.route and fields.status, as own data properties, so an IP, a request
// id or any other field never reaches a sum. The window has an upper bound.

/** The longest window, in minutes; older minutes are dropped. */
export const MAX_WINDOW_MINUTES = 1440;
/** (minute, route, status) entries kept in all; a new entry above it is not counted. */
export const MAX_ENTRIES = 50_000;
const MINUTE_MS = 60_000;
/** The traffic.request route of the log catalog (server/log/events/catalog.ts ROUTE_RE) or none. */
const ROUTE = /^(?:none|\/api\/v1(?:\/(?:[a-z0-9-]{1,40}|\{[A-Za-z]{1,40}\})){0,10})$/;

export const TRAFFIC_SUMMARY_ERROR_CODES = Object.freeze([
  "TRAFFIC_WINDOW_INVALID",
  "TRAFFIC_WINDOW_TOO_LARGE",
] as const);
type ErrorCode = (typeof TRAFFIC_SUMMARY_ERROR_CODES)[number];

export type TrafficSummaryRow = {
  readonly route: string;
  readonly status: number;
  readonly count: number;
};
export type TrafficSummaryValue = {
  readonly windowMinutes: number;
  readonly total: number;
  readonly rows: readonly TrafficSummaryRow[];
};
export type TrafficSummaryResult =
  | { readonly ok: true; readonly value: TrafficSummaryValue }
  | {
      readonly ok: false;
      readonly error: { readonly code: ErrorCode; readonly messageKey: string };
    };

export type TrafficSummary = {
  /** Counts one traffic.request record in the current minute; anything else is skipped. Never throws. */
  readonly observe: (input: unknown) => void;
  /** Sums of the last windowMinutes minutes, the current one included. */
  readonly summarize: (windowMinutes: unknown) => TrafficSummaryResult;
};

export type TrafficSummaryOptions = {
  /** The clock in ms; a fake one in tests. */
  readonly now: () => number;
};

const failure = (code: ErrorCode): TrafficSummaryResult =>
  Object.freeze({
    ok: false as const,
    error: Object.freeze({ code, messageKey: `trafficSummary.${code.toLowerCase()}` }),
  });

/** An own data property's value; a getter, an inherited key or a trap gives undefined. */
function ownValue(target: unknown, key: string): unknown {
  if (typeof target !== "object" || target === null || Array.isArray(target)) return undefined;
  return Object.getOwnPropertyDescriptor(target, key)?.value;
}

const isRoute = (value: unknown): value is string => typeof value === "string" && ROUTE.test(value);

export function createTrafficSummary(options: TrafficSummaryOptions): TrafficSummary {
  const { now } = options;
  /** Minute number to (route, status) counts; the key is "status route". */
  const minutes = new Map<number, Map<string, number>>();
  let entries = 0;

  /** The current minute; a clock that throws or gives no finite number gives undefined. */
  const minuteNow = (): number | undefined => {
    try {
      const ms = now();
      return Number.isFinite(ms) ? Math.floor(ms / MINUTE_MS) : undefined;
    } catch {
      return undefined;
    }
  };
  /** Drops minutes at or before current − MAX_WINDOW_MINUTES, relative to this clock reading. */
  const prune = (current: number): void => {
    for (const [minute, pairs] of minutes) {
      if (minute > current - MAX_WINDOW_MINUTES) continue;
      entries -= pairs.size;
      minutes.delete(minute);
    }
  };

  return Object.freeze({
    observe(input: unknown): void {
      try {
        if (ownValue(input, "event") !== "traffic.request") return;
        const fields = ownValue(input, "fields");
        const route = ownValue(fields, "route");
        const status = ownValue(fields, "status");
        if (!isRoute(route) || !Number.isSafeInteger(status)) return;
        if ((status as number) < 100 || (status as number) > 599) return;
        const minute = minuteNow();
        if (minute === undefined) return;
        prune(minute);
        const pairs = minutes.get(minute) ?? new Map<string, number>();
        const key = `${status as number} ${route}`;
        if (!pairs.has(key)) {
          if (entries >= MAX_ENTRIES) return;
          entries += 1;
        }
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
        minutes.set(minute, pairs);
      } catch {
        // A record that cannot be read is not counted.
      }
    },
    summarize(windowMinutes: unknown): TrafficSummaryResult {
      if (typeof windowMinutes === "number" && windowMinutes > MAX_WINDOW_MINUTES) {
        return failure("TRAFFIC_WINDOW_TOO_LARGE");
      }
      if (!Number.isSafeInteger(windowMinutes) || (windowMinutes as number) < 1) {
        return failure("TRAFFIC_WINDOW_INVALID");
      }
      const window = windowMinutes as number;
      const current = minuteNow();
      const sums = new Map<string, number>();
      if (current !== undefined) {
        prune(current);
        for (const [minute, pairs] of minutes) {
          if (minute <= current - window || minute > current) continue;
          for (const [key, count] of pairs) sums.set(key, (sums.get(key) ?? 0) + count);
        }
      }
      const rows = [...sums].map(([key, count]) => {
        const space = key.indexOf(" ");
        const status = Number(key.slice(0, space));
        return Object.freeze({ route: key.slice(space + 1), status, count });
      });
      rows.sort((a, b) => (a.route === b.route ? a.status - b.status : a.route < b.route ? -1 : 1));
      const total = rows.reduce((sum, row) => sum + row.count, 0);
      return Object.freeze({
        ok: true as const,
        value: Object.freeze({ windowMinutes: window, total, rows: Object.freeze(rows) }),
      });
    },
  });
}

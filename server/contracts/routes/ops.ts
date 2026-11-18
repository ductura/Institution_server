import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// DAN-843-1b (S-1K.5-b, OPSEG Ductus#2028 c.6981773723): the operator's read
// of the log chain, a contract without a handler (843-2). The source is the read of
// S-1K.5-a, the function public.operator_log (db/logs/migrations,
// DAN-835-1): a window of at most 24 hours, at most 1000 rows a call in seq
// order, each row masked by the function. Every pattern is ASCII only ([0-9], never \d, which some
// validators read as any Unicode digit) and ends at the end of the input,
// never at a final line feed ($ does in some languages).
const END = "(?![\\s\\S])";
// A day of the proleptic Gregorian calendar, years 0001 to 9999: the days of
// each month and 29 February only in a leap year (as student.access-log.get).
const YEAR = "(?!0000)[0-9]{4}";
const LEAP_YEAR =
  "(?!0000)(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)";
const MONTH_DAY = [
  "(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])",
  "(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)",
  "02-(?:0[1-9]|1[0-9]|2[0-8])",
].join("|");
const DAY = `(?:${YEAR}-(?:${MONTH_DAY})|${LEAP_YEAR}-02-29)`;
const CLOCK = "(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]";
/** A UTC instant of the query: seconds, and up to three decimals. */
const QueryInstant = Type.String({ pattern: `^${DAY}T${CLOCK}(?:\\.[0-9]{1,3})?Z${END}` });
/** A UTC instant of the answer, as Date.toISOString gives it. */
const Instant = Type.String({ pattern: `^${DAY}T${CLOCK}\\.[0-9]{3}Z${END}` });
/**
 * A decimal from 0 to `max` without a leading zero, as alternatives digit by
 * digit: every shorter number, then each digit of `max` lowered with any
 * digits after it, then `max` itself.
 */
function upTo(max: string): string {
  const any = (n: number) => (n === 0 ? "" : n === 1 ? "[0-9]" : `[0-9]{${n}}`);
  const below = [...max].flatMap((digit, i) => {
    const low = i === 0 ? 1 : 0;
    const high = Number(digit) - 1;
    if (high < low) return [];
    const range = high === low ? `${low}` : `[${low}-${high}]`;
    return [`${max.slice(0, i)}${range}${any(max.length - 1 - i)}`];
  });
  return `(?:0|[1-9][0-9]{0,${max.length - 2}}|${below.join("|")}|${max})`;
}
/** after: a seq to start after, 0 to 2^53-1 (Number.MAX_SAFE_INTEGER). */
const AFTER = `^${upTo(String(Number.MAX_SAFE_INTEGER))}${END}`;
/** A seq of log_entry (bigint, from 1) as far as a JSON number holds it exactly. */
const Seq = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** A record kind, as the check log_entry_kind_shape. */
const Kind = Type.String({
  maxLength: 64,
  pattern: `^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*${END}`,
});
/** operator_log keeps requestId and accountKind only in these shapes, otherwise null. */
const RequestId = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const AccountKind = Type.String({ pattern: `^[a-z_]{1,32}${END}` });
/** operator_log's fields: names of ASCII letters and digits, scalar values only. */
const Fields = Type.Record(
  Type.String({ pattern: `^[A-Za-z][A-Za-z0-9]*${END}` }),
  Type.Union([Type.String(), Type.Number(), Type.Boolean(), Type.Null()]),
  { additionalProperties: false },
);

export const opsEventsGet = defineRoute({
  id: "ops.events.get",
  method: "GET",
  path: "/api/v1/ops/events",
  inventory: "app/api/ops/events/route.ts",
  // Who passes is decided before the route, by the pipeline: the network
  // (step 3), then a live session, the server's operator list and a
  // confirmed WebAuthn factor (step 8), which answers 503 when it cannot ask.
  access: "signed_in",
  summary:
    'The operator\'s read of the log: the records of a window, at most 1000 a page, in seq order, each as the operator read (operator_log) masks it (an address only as a network: the host part is always cut, a mask longer than /24 for IPv4 or /48 for IPv6 is cut to it, a shorter one such as /8 stays; no token, cookie or session value; a value the read cannot vouch for is "hidden"). The pipeline decides who reaches it, before the route: 403 forbidden from a network outside the list (step 3), or for an account not on the operator list of the server or without a confirmed second factor (step 8); 401 unauthenticated without a live session (step 8); 503 unavailable when step 8 cannot ask the operator list or the second factor. from and to are UTC instants of the calendar, the window is from inclusive to exclusive, from before to and at most 24 hours apart (exactly 24 is allowed); after is the seq the page starts after (0 by default), a decimal of 0 to 2^53-1 without a leading zero. A repeated or unknown parameter, or a window outside these bounds, is 422 and reads nothing. next is the seq of the last event when the page is full (1000), to pass as after, and may then lead to an empty page; null when the page is shorter. A row the read cannot vouch for makes the whole answer 503, never a shorter page.',
  request: {
    query: closed({
      from: QueryInstant,
      to: QueryInstant,
      after: Type.Optional(Type.String({ pattern: AFTER })),
    }),
  },
  responses: [
    {
      status: 200,
      description: "a page of events, possibly none",
      body: closed({
        events: Type.Array(
          closed({
            seq: Seq,
            at: Instant,
            kind: Kind,
            requestId: Type.Union([RequestId, Type.Null()]),
            accountKind: Type.Union([AccountKind, Type.Null()]),
            fields: Fields,
          }),
          { maxItems: 1000 },
        ),
        next: Type.Union([Seq, Type.Null()]),
      }),
    },
  ],
  errors: [
    error(401, "unauthenticated"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const opsRoutes = [opsEventsGet] as const;

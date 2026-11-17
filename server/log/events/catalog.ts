// The closed catalog of log events (S-1K.1, DAN-796; docs/PLAN.md §6). Every
// record has a time, an event kind from this list, the server request id and
// the account kind (or `anonymous`). Its fields are closed too: a field is a
// code from a fixed list, a bounded integer, a flag, an id, a version or a
// route template from the server's own inventory. No field takes free text, so
// the text of a work or a personal datum has no field to travel in.
//
// Only the catalog and its check live here; the service that writes records is
// S-1K.3-a. log imports only settings (docs/server-map.md §2), so the account
// kinds and actions of server/roles are copied below and server/roles/index.test.ts
// checks that the copies stay equal.
import { isIPv6 } from "node:net";
import { types } from "node:util";

/** server/roles ACCOUNT_KINDS, in the same order. */
export const LOG_ACCOUNT_KINDS = Object.freeze([
  "student",
  "teacher",
  "institution_admin",
  "app_admin",
  "network_engineer",
] as const);

/** Who a record is about: an account kind, or `anonymous` when no account is signed in. */
export const LOG_ACTORS = Object.freeze([...LOG_ACCOUNT_KINDS, "anonymous"] as const);
export type LogActor = (typeof LOG_ACTORS)[number];

/** server/roles ACTIONS, in the same order. */
export const LOG_ACTIONS = Object.freeze([
  "read_own_work",
  "read_students_work",
  "manage_courses_and_members",
  "assign_student_teacher_roles",
  "assign_admin_network_engineer_roles",
  "change_personal_settings",
  "change_course_settings",
  "change_institution_settings",
  "change_system_settings",
  "change_network_security_settings",
  "view_access_logs",
  "view_system_metrics",
  "manage_ip_rules",
  "export_logs",
  "backup_and_restore",
  "edit_general_legal_texts",
  "edit_institution_legal_addendum",
  "delete_draft",
  "request_submitted_work_deletion",
  "approve_submitted_work_deletion",
  "request_personal_data_erasure",
  "execute_personal_data_erasure",
  "archive_course",
] as const);

/** Actions a kind 3–5 account may take: a scope other than `none` in the permissions table. */
export const ADMIN_LOG_ACTIONS = Object.freeze([
  "manage_courses_and_members",
  "assign_student_teacher_roles",
  "assign_admin_network_engineer_roles",
  "change_personal_settings",
  "change_course_settings",
  "change_institution_settings",
  "change_system_settings",
  "change_network_security_settings",
  "view_access_logs",
  "view_system_metrics",
  "manage_ip_rules",
  "export_logs",
  "backup_and_restore",
  "edit_general_legal_texts",
  "edit_institution_legal_addendum",
  "approve_submitted_work_deletion",
  "execute_personal_data_erasure",
  "archive_course",
] as const);

/** One field of an event. There is deliberately no kind for a free string. */
export type FieldSpec =
  | { readonly kind: "code"; readonly values: readonly string[] }
  | { readonly kind: "int"; readonly min: number; readonly max: number }
  | { readonly kind: "flag" }
  /** A lowercase UUID, as the server makes them. */
  | { readonly kind: "id" }
  /** `major.minor.patch`, digits only. */
  | { readonly kind: "version" }
  /** A route template that must be in the inventory passed to checkEvent. */
  | { readonly kind: "route" }
  /** A route template as `route`, or `none` for a path that is no route (DAN-831-1). */
  | { readonly kind: "routeOrNone" }
  /**
   * A client IP as server/traffic clientIpOf writes it, or `none` without one
   * (DAN-831-1; D-303). Its field is named so that redact drops it from any
   * console line: the address goes only to the log database.
   */
  | { readonly kind: "ip" };

export type EventSpec = {
  readonly actors: readonly LogActor[];
  readonly fields: Readonly<Record<string, FieldSpec>>;
};

const code = (...values: string[]): FieldSpec => ({ kind: "code", values });
const int = (min: number, max: number): FieldSpec => ({ kind: "int", min, max });
const FLAG: FieldSpec = { kind: "flag" };
const ID: FieldSpec = { kind: "id" };
const VERSION: FieldSpec = { kind: "version" };
const ROUTE: FieldSpec = { kind: "route" };
const ROUTE_OR_NONE: FieldSpec = { kind: "routeOrNone" };
const IP: FieldSpec = { kind: "ip" };
const DURATION_MS = int(0, 86_400_000);
const COUNT = int(0, Number.MAX_SAFE_INTEGER);

const ANYONE: readonly LogActor[] = LOG_ACTORS;
const SIGNED_IN: readonly LogActor[] = LOG_ACCOUNT_KINDS;
const ANONYMOUS: readonly LogActor[] = ["anonymous"];
const ADMINS: readonly LogActor[] = ["institution_admin", "app_admin", "network_engineer"];
/** Backup runs on a schedule (no account) or by hand (permissions table, `backup_and_restore`). */
const BACKUP: readonly LogActor[] = ["app_admin", "network_engineer", "anonymous"];

const SERVICE = code("srce_auth", "storage", "keys", "email");
const LEGAL_TEXT = code("terms_of_use", "privacy_notice", "institution_addendum");
const DELETION_SUBJECT = code("submitted_work", "personal_data");
const AREA = code(
  ...["http", "traffic", "session", "roles", "legal", "backup", "deletion", "downloads"],
  ...["database", "srce_auth", "storage", "keys", "email", "log", "metrics", "settings"],
);

/** Every event kind and its fields. A kind that is not a key here is refused. */
export const EVENT_CATALOG = {
  // Login (authn).
  "authn.login_started": { actors: ANONYMOUS, fields: { method: code("aai_eduhr") } },
  "authn.login_succeeded": { actors: SIGNED_IN, fields: { method: code("aai_eduhr") } },
  "authn.login_failed": {
    actors: ANONYMOUS,
    fields: {
      reason: code(
        ...["denied_by_provider", "state_mismatch", "nonce_mismatch", "token_invalid"],
        ...["token_expired", "provider_unavailable", "account_not_allowed", "cancelled"],
      ),
    },
  },
  "authn.second_factor_succeeded": { actors: ["network_engineer"], fields: {} },
  "authn.second_factor_failed": {
    actors: ["network_engineer"],
    fields: { reason: code("wrong_key", "cloned_key", "timeout", "not_registered", "cancelled") },
  },
  "authn.logout": { actors: SIGNED_IN, fields: { initiator: code("user", "backchannel") } },
  // Session and cookies.
  "session.created": { actors: SIGNED_IN, fields: { secondFactor: FLAG } },
  "session.expired": { actors: SIGNED_IN, fields: { reason: code("idle", "absolute") } },
  "session.revoked": {
    actors: SIGNED_IN,
    // The close reasons of identity.session (server/session/state.ts, DAN-830).
    fields: {
      reason: code(
        ...["logout", "logout_all", "backchannel_logout", "institution_changed"],
        ...["issuer_removed", "operator", "superseded", "role_changed", "account_disabled"],
      ),
    },
  },
  "session.cookie_rejected": {
    actors: ANONYMOUS,
    fields: { reason: code("wrong_prefix", "malformed", "unknown", "expired", "revoked") },
  },
  // Authorization (authz).
  "authz.denied": {
    actors: ANYONE,
    fields: {
      action: code(...LOG_ACTIONS),
      reason: code(
        ...["not_signed_in", "scope_none", "no_relation", "other_institution"],
        "second_factor_required",
      ),
    },
  },
  // A refusal of step 8 (S-1J.2, DAN-842-3): before the router no account is
  // resolved, so the record is anonymous even when a session is live (as
  // session.cookie_rejected), and no action is known; the route only as a
  // contract path.
  "authz.operator_refused": {
    actors: ANONYMOUS,
    fields: {
      route: ROUTE_OR_NONE,
      reason: code("not_signed_in", "second_factor_required", "second_factor_unavailable"),
    },
  },
  "authz.origin_rejected": {
    actors: ANYONE,
    fields: {
      route: ROUTE,
      reason: code("origin_missing", "origin_not_allowed", "cross_site", "logout_token_invalid"),
    },
  },
  // Traffic (docs/server-map.md §3: written when the answer ends). Every
  // request gets one: OTHER for any other method, route none for a path that
  // is no route.
  "traffic.request": {
    actors: ANYONE,
    fields: {
      method: code("GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "OTHER"),
      route: ROUTE_OR_NONE,
      ip: IP,
      status: int(100, 599),
      durationMs: DURATION_MS,
      ipRule: code("allowed", "denied", "not_checked"),
      rateLimit: code("allowed", "limited", "not_checked"),
    },
  },
  "traffic.ip_denied": {
    actors: ANYONE,
    fields: { route: ROUTE, rule: code("blocked_range", "not_in_allowed_ranges", "operator_only") },
  },
  "traffic.rate_limited": {
    actors: ANYONE,
    fields: { route: ROUTE, bucket: code("per_address", "per_account", "per_route") },
  },
  // External services.
  "external.call_failed": {
    actors: ANYONE,
    fields: {
      service: SERVICE,
      outcome: code("timeout", "unavailable", "error_response", "invalid_response"),
      durationMs: DURATION_MS,
    },
  },
  "external.call_slow": { actors: ANYONE, fields: { service: SERVICE, durationMs: DURATION_MS } },
  // Actions of account kinds 3–5.
  "admin.action": {
    actors: ADMINS,
    fields: {
      action: code(...ADMIN_LOG_ACTIONS),
      outcome: code("succeeded", "failed"),
      institutionId: ID,
      // The operator's account (a UUID, never a name, e-mail or address); kinds
      // 3–5 only, owner decision Ductus#2012 c.6917729838 (DAN-841).
      userId: ID,
    },
  },
  // Metrics.
  "metrics.collected": {
    actors: ANONYMOUS,
    fields: {
      metric: code(
        ...["request_count", "error_count", "latency_p95_ms", "active_sessions"],
        ...["queue_depth", "disk_free_percent", "database_connections"],
      ),
      value: COUNT,
    },
  },
  // Client context (S-1M-b, DAN-846; D-300: kinds only, no fingerprint). The
  // lists equal CLIENT_CONTEXT_VALUES of server/contracts (checked in http).
  "client.context_reported": {
    actors: ANYONE,
    fields: {
      app: code("web", "desktop"),
      appVersion: VERSION,
      os: code("windows", "macos", "linux", "android", "ios", "other"),
      browser: code("chromium", "firefox", "safari", "other"),
      device: code("desktop", "tablet", "phone", "other"),
      screen: code("compact", "medium", "expanded"),
    },
  },
  // Legal texts (D-301).
  "legal.text_published": {
    actors: ["institution_admin", "app_admin"],
    fields: { legalText: LEGAL_TEXT, version: int(1, 1_000_000) },
  },
  "legal.text_accepted": {
    actors: SIGNED_IN,
    fields: { legalText: LEGAL_TEXT, version: int(1, 1_000_000) },
  },
  // Backup.
  "backup.started": { actors: BACKUP, fields: { trigger: code("scheduled", "manual") } },
  "backup.completed": { actors: BACKUP, fields: { durationMs: DURATION_MS, sizeBytes: COUNT } },
  "backup.failed": {
    actors: BACKUP,
    fields: {
      stage: code("dump", "encrypt", "upload", "verify"),
      reason: code(
        ...["timeout", "storage_unavailable", "key_unavailable", "checksum_mismatch"],
        "unexpected",
      ),
    },
  },
  "backup.restore_started": { actors: BACKUP, fields: {} },
  "backup.restore_completed": { actors: BACKUP, fields: { durationMs: DURATION_MS } },
  "backup.restore_failed": {
    actors: BACKUP,
    fields: {
      reason: code("wrong_key", "checksum_mismatch", "storage_unavailable", "unexpected"),
    },
  },
  // Deletion (D-299).
  "deletion.draft_deleted": { actors: ["student"], fields: { workId: ID } },
  "deletion.requested": {
    actors: ["student"],
    fields: { subject: DELETION_SUBJECT, deletionId: ID },
  },
  "deletion.approved": {
    actors: ["institution_admin"],
    fields: { subject: DELETION_SUBJECT, deletionId: ID },
  },
  "deletion.rejected": {
    actors: ["institution_admin"],
    fields: { subject: DELETION_SUBJECT, deletionId: ID },
  },
  "deletion.executed": {
    actors: ["institution_admin", "anonymous"],
    fields: { subject: DELETION_SUBJECT, deletionId: ID },
  },
  "deletion.course_archived": { actors: ["institution_admin"], fields: { courseId: ID } },
  "deletion.retention_purged": {
    actors: ANONYMOUS,
    fields: { store: code("main", "logs"), count: COUNT },
  },
  // Warnings.
  "warning.raised": {
    actors: ANONYMOUS,
    fields: {
      warning: code(
        ...["disk_low", "error_rate_high", "latency_high", "backup_overdue"],
        ...["external_service_down", "key_rotation_due", "certificate_expiring"],
      ),
      severity: code("warning", "critical"),
    },
  },
  // Unexpected programming errors (docs/server-map.md §3), without message or stack.
  "error.unexpected": {
    actors: ANYONE,
    fields: {
      area: AREA,
      errorClass: code(
        ...["type_error", "range_error", "reference_error", "syntax_error"],
        ...["database_error", "timeout", "other"],
      ),
    },
  },
} as const satisfies Readonly<Record<string, EventSpec>>;

/** Freezes every object and array under `value`, so no importer can widen the catalog. */
function deepFreeze(value: unknown): void {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze((value as Record<string | symbol, unknown>)[key]);
  }
}
deepFreeze(EVENT_CATALOG);

export type EventKind = keyof typeof EVENT_CATALOG;

export const EVENT_KINDS: readonly EventKind[] = Object.freeze(
  Object.keys(EVENT_CATALOG) as EventKind[],
);

// The lookup is a Map, so `__proto__`, `constructor` and other inherited names are not kinds.
const SPECS: ReadonlyMap<string, EventSpec> = new Map(Object.entries(EVENT_CATALOG));

/** A checked record: fresh, frozen, holding only the values the catalog allows. */
export type LogRecord = {
  readonly time: string;
  readonly event: EventKind;
  readonly requestId: string;
  readonly accountKind: LogActor;
  readonly fields: Readonly<Record<string, string | number | boolean>>;
};

/** Why a record was refused: a code and its message key, never the refused value. */
export const CATALOG_ERROR_CODES = Object.freeze([
  "NOT_A_PLAIN_OBJECT",
  "UNKNOWN_KEY",
  "MISSING_KEY",
  "BAD_TIME",
  "UNKNOWN_EVENT",
  "BAD_REQUEST_ID",
  "UNKNOWN_ACCOUNT_KIND",
  "ACCOUNT_KIND_NOT_ALLOWED",
  "UNKNOWN_FIELD",
  "MISSING_FIELD",
  "BAD_FIELD_VALUE",
  "BAD_OPTIONS",
] as const);

export type CatalogErrorCode = (typeof CATALOG_ERROR_CODES)[number];

export type CatalogResult =
  | { readonly ok: true; readonly value: LogRecord }
  | {
      readonly ok: false;
      readonly error: { readonly code: CatalogErrorCode; readonly messageKey: string };
    };

export type CheckOptions = {
  /**
   * The route templates of the server's inventory (a real Set, never request
   * paths); a route field must be one of them. Without it no route passes.
   */
  readonly routes?: ReadonlySet<string>;
};

const RECORD_KEYS = ["time", "event", "requestId", "accountKind", "fields"] as const;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** The request id of server/http/request-id.ts: a lowercase UUID v4. */
const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION_RE = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})$/;
/**
 * A template, not a path: lowercase segments and `{param}` as in
 * server/contracts (RouteContract.path), no query; checked again by inventory.
 */
const ROUTE_RE = /^\/api\/v1(?:\/(?:[a-z0-9-]{1,40}|\{[A-Za-z]{1,40}\})){0,10}$/;
const NO_ROUTES: ReadonlySet<string> = new Set();
/** The word for a missing route or client IP. */
const NONE = "none";
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_CHARS_RE = /^[0-9a-f:]{2,39}$/;
/** IPv4-mapped IPv6, which clientIpOf writes as the IPv4 address. */
const MAPPED_RE = /^::ffff:[0-9a-f]{1,4}:[0-9a-f]{1,4}$/;

/**
 * IPv4 dotted without leading zeros, or IPv6 exactly as RFC 5952 writes it:
 * the URL serializer compresses the first longest run of two or more zero
 * words and writes lower-case hex without leading zeros, as clientIpOf does
 * (server/traffic/client-ip-log.property.test.ts checks the parity).
 */
function ipOk(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value === NONE || IPV4_RE.test(value)) return true;
  if (!IPV6_CHARS_RE.test(value) || !isIPv6(value) || MAPPED_RE.test(value)) return false;
  return new URL(`http://[${value}]/`).hostname === `[${value}]`;
}

const routeOk = (value: unknown, routes: ReadonlySet<string>): boolean =>
  typeof value === "string" && ROUTE_RE.test(value) && setHas.call(routes, value);
// Set.prototype.has itself, so an inventory with its own `has` cannot widen the check.
const setHas = Set.prototype.has;

/** The inventory from `options`, read without running caller code; undefined if unusable. */
function routesOf(options: unknown): ReadonlySet<string> | undefined {
  if (options === undefined) return NO_ROUTES;
  if (typeof options !== "object" || options === null || types.isProxy(options)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(options, "routes");
  if (descriptor === undefined) return NO_ROUTES;
  if (!("value" in descriptor)) return undefined;
  const routes: unknown = descriptor.value;
  if (routes === undefined) return NO_ROUTES;
  return types.isSet(routes) && !types.isProxy(routes)
    ? (routes as ReadonlySet<string>)
    : undefined;
}

/**
 * The message key of each code (docs/CODE_STYLE.md §8); the Croatian text is in
 * locales/hr.json under `logCatalog`.
 */
export function catalogMessageKey(errorCode: CatalogErrorCode): string {
  return `logCatalog.${errorCode.toLowerCase()}`;
}

const refuse = (errorCode: CatalogErrorCode): CatalogResult =>
  Object.freeze({
    ok: false,
    error: Object.freeze({ code: errorCode, messageKey: catalogMessageKey(errorCode) }),
  });

/**
 * The own data properties of a plain object, keyed exactly as `allowed`, or a
 * refusal. Proxies, arrays, class instances, symbol keys, getters and setters,
 * and any key outside `allowed` (`__proto__` included) are refused, so the
 * values read here are the values checked and no code runs while reading.
 */
function readExact(
  value: unknown,
  allowed: readonly string[],
): CatalogResult | Map<string, unknown> {
  if (typeof value !== "object" || value === null || types.isProxy(value)) {
    return refuse("NOT_A_PLAIN_OBJECT");
  }
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return refuse("NOT_A_PLAIN_OBJECT");
  const read = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.includes(key)) return refuse("UNKNOWN_KEY");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) return refuse("NOT_A_PLAIN_OBJECT");
    read.set(key, descriptor.value);
  }
  return read;
}

function fieldOk(spec: FieldSpec, value: unknown, routes: ReadonlySet<string>): boolean {
  switch (spec.kind) {
    case "code":
      return typeof value === "string" && spec.values.includes(value);
    case "int":
      return Number.isSafeInteger(value) && Number(value) >= spec.min && Number(value) <= spec.max;
    case "flag":
      return typeof value === "boolean";
    case "id":
      return typeof value === "string" && ID_RE.test(value);
    case "version":
      return typeof value === "string" && VERSION_RE.test(value);
    case "route":
      return routeOk(value, routes);
    case "routeOrNone":
      return value === NONE || routeOk(value, routes);
    case "ip":
      return ipOk(value);
  }
}

function timeOk(value: unknown): value is string {
  if (typeof value !== "string" || !TIME_RE.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isActor(value: unknown): value is LogActor {
  return typeof value === "string" && (LOG_ACTORS as readonly string[]).includes(value);
}

/** Checks one record against the catalog; nothing outside it passes. Never throws. */
export function checkEvent(input: unknown, options?: CheckOptions): CatalogResult {
  try {
    return checkRecord(input, options);
  } catch {
    // Last net: a check that cannot finish refuses the record.
    return refuse("BAD_OPTIONS");
  }
}

function checkRecord(input: unknown, options: unknown): CatalogResult {
  const routes = routesOf(options);
  if (routes === undefined) return refuse("BAD_OPTIONS");
  const record = readExact(input, RECORD_KEYS);
  if (!(record instanceof Map)) return record;
  if (RECORD_KEYS.some((key) => !record.has(key))) return refuse("MISSING_KEY");

  const time = record.get("time");
  if (!timeOk(time)) return refuse("BAD_TIME");
  const event = record.get("event");
  const spec = typeof event === "string" ? SPECS.get(event) : undefined;
  if (spec === undefined) return refuse("UNKNOWN_EVENT");
  const requestId = record.get("requestId");
  if (typeof requestId !== "string" || !REQUEST_ID_RE.test(requestId)) {
    return refuse("BAD_REQUEST_ID");
  }
  const accountKind = record.get("accountKind");
  if (!isActor(accountKind)) return refuse("UNKNOWN_ACCOUNT_KIND");
  if (!spec.actors.includes(accountKind)) return refuse("ACCOUNT_KIND_NOT_ALLOWED");

  const names = Object.keys(spec.fields);
  const fields = readExact(record.get("fields"), names);
  if (!(fields instanceof Map)) {
    return fields.ok
      ? fields
      : refuse(fields.error.code === "UNKNOWN_KEY" ? "UNKNOWN_FIELD" : fields.error.code);
  }
  // No prototype, so a polluted Object.prototype setter cannot catch a value.
  const checked = Object.create(null) as Record<string, string | number | boolean>;
  for (const name of names) {
    if (!fields.has(name)) return refuse("MISSING_FIELD");
    const value = fields.get(name);
    const fieldSpec = spec.fields[name];
    if (fieldSpec === undefined || !fieldOk(fieldSpec, value, routes)) {
      return refuse("BAD_FIELD_VALUE");
    }
    checked[name] = value as string | number | boolean;
  }
  return Object.freeze({
    ok: true,
    value: Object.freeze({
      time,
      event: event as EventKind,
      requestId,
      accountKind,
      fields: Object.freeze(checked),
    }),
  });
}

/** True for an event kind in the catalog: exact spelling, no trimming, no case folding. */
export function isEventKind(value: unknown): value is EventKind {
  return typeof value === "string" && SPECS.has(value);
}

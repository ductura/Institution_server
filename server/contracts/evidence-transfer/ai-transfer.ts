/**
 * The `ductus-ai-transfer-v1` record (SRV-1809, plan M9.0-S1, D-269 O8;
 * Ductus docs/contracts/evidence-segment-v4.md, "Zapisi na koje odsječak
 * upućuje"). A v4 segment event with source `ai-transfer` points at one such
 * record by `aiTransferId` and `aiTransferSha256` = SHA-256(JCS(record)).
 *
 * Only the server creates it, through an RPC; the client never writes it.
 * The record carries no conversation content, instructions or transferred
 * text (C11): the text stays in the conversation under RLS, the record holds
 * only its hash. Provider and model are shapes only; whether they are allowed
 * is decided by the server at creation (`checkAiTransferAllowedV1`), from the
 * versioned faculty configuration. No real provider or model is named here
 * or in the tests while Q-10 is open: tests use `provider-test-a` and
 * `model-test-1`.
 *
 * PRIJEDLOG until the contract review, like SRV-1801.
 */
import { Type, type Static } from "@sinclair/typebox";

import { SHA256_HEX_PATTERN, UUID_V4_PATTERN } from "../import/index.ts";

export const AI_TRANSFER_SCHEMA_V1 = "ductus-ai-transfer-v1";

/** Same shapes as the port of server/domain/assistant (`PROVIDER_ID_PATTERN`, `MODEL_ID_PATTERN`). */
export const AI_TRANSFER_PROVIDER_ID_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}$";
export const AI_TRANSFER_MODEL_ID_PATTERN = "^[a-z0-9][a-z0-9._-]{0,127}$";
/** `purposeId` and `phaseId`. */
export const AI_TRANSFER_CATALOG_KEY_PATTERN = "^[a-z0-9][a-z0-9_-]{0,63}$";
/** 2^31 − 1: the largest catalogue version (a PostgreSQL integer). */
export const MAX_AI_TRANSFER_CATALOG_VERSION = 2_147_483_647;
/** Same bound as a segment's `documentId` (MAX_ID_LENGTH of segment v2 to v4). */
export const MAX_AI_TRANSFER_DOCUMENT_ID_LENGTH = 256;
const WHOLE_MINUTE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$";

/** Keys in the order the record lists them; all are required. */
export const AI_TRANSFER_KEYS_V1 = Object.freeze([
  "transferSchema",
  "transferId",
  "documentId",
  "conversationId",
  "responseId",
  "providerId",
  "modelId",
  "purposeCatalogVersion",
  "purposeId",
  "phaseId",
  "textSha256",
  "transferredAt",
] as const);

const Uuid = Type.String({ pattern: UUID_V4_PATTERN });

export const AiTransferRecordV1 = Type.Object(
  {
    transferSchema: Type.Literal(AI_TRANSFER_SCHEMA_V1),
    /** Equal to `aiTransferId` of the event that points at the record. */
    transferId: Uuid,
    documentId: Type.String({ minLength: 1, maxLength: MAX_AI_TRANSFER_DOCUMENT_ID_LENGTH }),
    conversationId: Uuid,
    responseId: Uuid,
    providerId: Type.String({ pattern: AI_TRANSFER_PROVIDER_ID_PATTERN }),
    modelId: Type.String({ pattern: AI_TRANSFER_MODEL_ID_PATTERN }),
    purposeCatalogVersion: Type.Integer({ minimum: 1, maximum: MAX_AI_TRANSFER_CATALOG_VERSION }),
    purposeId: Type.String({ pattern: AI_TRANSFER_CATALOG_KEY_PATTERN }),
    phaseId: Type.String({ pattern: AI_TRANSFER_CATALOG_KEY_PATTERN }),
    /** Hash of the transferred text, by the definition of the event text (event-text.ts). */
    textSha256: Type.String({ pattern: SHA256_HEX_PATTERN }),
    /** A whole UTC minute from the server's database clock, never from the client (O-5). */
    transferredAt: Type.String({ pattern: WHOLE_MINUTE_PATTERN }),
  },
  { additionalProperties: false },
);
export type AiTransferRecordV1 = Readonly<Static<typeof AiTransferRecordV1>>;

/** Codes only: a rejection never carries input content. */
export const AI_TRANSFER_REJECT_CODES = Object.freeze([
  "TRANSFER_INVALID",
  "TRANSFER_NOT_CANONICAL",
  "PROVIDER_NOT_ALLOWED",
  "PURPOSE_NOT_ALLOWED",
] as const);
export type AiTransferRejectCode = (typeof AI_TRANSFER_REJECT_CODES)[number];

export type AiTransferResult =
  | { readonly ok: true; readonly record: AiTransferRecordV1 }
  | { readonly ok: false; readonly code: AiTransferRejectCode };

const INVALID: AiTransferResult = Object.freeze({ ok: false, code: "TRANSFER_INVALID" });
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
const UUID_V4 = new RegExp(UUID_V4_PATTERN, "u");
const SHA256_HEX = new RegExp(SHA256_HEX_PATTERN, "u");
const PROVIDER_ID = new RegExp(AI_TRANSFER_PROVIDER_ID_PATTERN, "u");
const MODEL_ID = new RegExp(AI_TRANSFER_MODEL_ID_PATTERN, "u");
const CATALOG_KEY = new RegExp(AI_TRANSFER_CATALOG_KEY_PATTERN, "u");
const WHOLE_MINUTE = new RegExp(WHOLE_MINUTE_PATTERN, "u");

const isString = (value: unknown, pattern: RegExp): value is string =>
  typeof value === "string" && pattern.test(value);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A real instant at a whole UTC minute, in the one D-24 spelling. */
function isWholeMinute(value: unknown): boolean {
  if (!isString(value, WHOLE_MINUTE)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isDocumentId(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.trim() !== "" &&
    value.length <= MAX_AI_TRANSFER_DOCUMENT_ID_LENGTH &&
    !LONE_SURROGATE.test(value)
  );
}

/**
 * The checks of {@link AiTransferRecordV1} plus what a schema cannot say (a
 * real minute, no lone surrogate, no symbol or inherited key). Done by hand
 * because contracts import only `@sinclair/typebox`; a test holds the schema
 * and this function to the same answers.
 */
function isRecord(v: Record<string, unknown>): boolean {
  if (Object.getOwnPropertySymbols(v).length > 0) return false;
  const keys = Object.keys(v);
  if (keys.length !== AI_TRANSFER_KEYS_V1.length) return false;
  if (!AI_TRANSFER_KEYS_V1.every((key) => Object.hasOwn(v, key))) return false;
  return (
    v.transferSchema === AI_TRANSFER_SCHEMA_V1 &&
    isString(v.transferId, UUID_V4) &&
    isDocumentId(v.documentId) &&
    isString(v.conversationId, UUID_V4) &&
    isString(v.responseId, UUID_V4) &&
    isString(v.providerId, PROVIDER_ID) &&
    isString(v.modelId, MODEL_ID) &&
    Number.isSafeInteger(v.purposeCatalogVersion) &&
    (v.purposeCatalogVersion as number) >= 1 &&
    (v.purposeCatalogVersion as number) <= MAX_AI_TRANSFER_CATALOG_VERSION &&
    isString(v.purposeId, CATALOG_KEY) &&
    isString(v.phaseId, CATALOG_KEY) &&
    isString(v.textSha256, SHA256_HEX) &&
    isWholeMinute(v.transferredAt)
  );
}

/** Reads one parsed value with the closed format and returns a clean, frozen copy. */
export function parseAiTransferRecordV1(value: unknown): AiTransferResult {
  if (!isPlainObject(value) || !isRecord(value)) return INVALID;
  const copy: Record<string, unknown> = {};
  for (const key of AI_TRANSFER_KEYS_V1) copy[key] = value[key];
  return { ok: true, record: Object.freeze(copy) as AiTransferRecordV1 };
}

/**
 * RFC 8785 (JCS) for the values a record holds: one flat object of strings
 * and safe integers. Keys sort by UTF-16 code units; strings use the
 * ECMAScript serialisation, which is what JCS prescribes.
 */
function jcs(record: AiTransferRecordV1): string {
  const fields = record as unknown as Record<string, string | number>;
  const keys = Object.keys(fields).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(fields[key])}`).join(",")}}`;
}

/**
 * The canonical text whose SHA-256 over its UTF-8 bytes is `aiTransferSha256`
 * of the event. Contracts hash nothing; the RPC that creates the record and
 * the RPC of commit and `reserve` do.
 */
export function canonicalAiTransferRecordV1(record: AiTransferRecordV1): string {
  return jcs(record);
}

/**
 * Reads record text: valid by {@link parseAiTransferRecordV1} and exactly the
 * JCS text of that value. A duplicate key, another key order, whitespace or
 * another spelling of a number is refused, never rewritten (B-8, K13).
 */
export function parseAiTransferRecordV1Text(text: string): AiTransferResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return INVALID;
  }
  const parsed = parseAiTransferRecordV1(value);
  if (!parsed.ok) return parsed;
  return canonicalAiTransferRecordV1(parsed.record) === text
    ? parsed
    : { ok: false, code: "TRANSFER_NOT_CANONICAL" };
}

/** One allowed provider and model, from the versioned faculty configuration. */
export type AiTransferAllowedModel = { readonly providerId: string; readonly modelId: string };

/**
 * What the server checks when it creates a record (C3, C4): the provider and
 * the model are one allowed pair of the faculty configuration, and the
 * purpose is in the catalogue version of the assignment and allowed by it.
 * The allowed lists come from the server's configuration, which already
 * refuses banned providers (D-194 t. 2, `parseProviderEntry`); an empty list
 * allows nothing.
 */
export function checkAiTransferAllowedV1(
  record: AiTransferRecordV1,
  allowed: {
    readonly models: readonly AiTransferAllowedModel[];
    readonly purposeCatalogVersion: number;
    readonly purposeIds: readonly string[];
  },
): AiTransferResult {
  const model = allowed.models.some(
    (entry) => entry.providerId === record.providerId && entry.modelId === record.modelId,
  );
  if (!model) return { ok: false, code: "PROVIDER_NOT_ALLOWED" };
  if (
    record.purposeCatalogVersion !== allowed.purposeCatalogVersion ||
    !allowed.purposeIds.includes(record.purposeId)
  )
    return { ok: false, code: "PURPOSE_NOT_ALLOWED" };
  return { ok: true, record };
}

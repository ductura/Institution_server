/**
 * The parser of an assistant request body (Ductus
 * docs/contracts/ai-request-v1.md, "Klase ulaza"; plan #1662 Z4 to Z7, Z9 to
 * Z11).
 *
 * The body size is checked on the raw bytes before anything is decoded or
 * parsed. The key set is closed at every level: the body is one flat object
 * with exactly five keys, and a value is a string, a number or null, never a
 * nested object. Identity, amounts, limits, provider, model and tools never
 * come from the client (T3, M5, Z4); the route takes them from the session and
 * from configuration.
 *
 * The paragraph is normalised to NFC and counted in Unicode code points after
 * normalisation (Z9). An empty or blank paragraph, a lone surrogate, a C0 or
 * C1 control other than tab and line feed, DEL, a byte order mark and the
 * bidirectional controls are refused (Z10). An instruction inside the
 * paragraph stays data: the parser does not read it (Z11, see `port.ts`).
 */
import { hasOnlyKeys, isPlainObject, ownProperty } from "../json/index.ts";

/** Longest paragraph, in code points after NFC (Z9). */
export const MAX_PARAGRAPH_CODE_POINTS = 5000;
/**
 * Largest body, in bytes, checked before parsing. Room for a paragraph at the
 * limit written entirely as JSON `\uXXXX` surrogate pairs (12 bytes per code
 * point) plus the other fields; a test keeps the two in step.
 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

export const ASSISTANT_REQUEST_KEYS = Object.freeze([
  "assignmentId",
  "conversationId",
  "paragraph",
  "purposeCatalogVersion",
  "purposeKey",
] as const);

/**
 * Keys the server decides and a client might try to send (Z4). They are
 * refused like every unknown key; the list only names the reason.
 */
export const CLIENT_CONTROLLED_KEYS: readonly string[] = Object.freeze([
  "actualMicro",
  "amount",
  "amountMicro",
  "configVersion",
  "costMicro",
  "institutionId",
  "limit",
  "limitMicro",
  "maxResponseCodePoints",
  "model",
  "modelId",
  "provider",
  "providerId",
  "reservedMicro",
  "studentId",
  "tool",
  "tools",
  "userId",
]);

export type AssistantRequest = {
  readonly idempotencyKey: string;
  readonly assignmentId: string;
  readonly conversationId: string | null;
  readonly purposeCatalogVersion: number;
  readonly purposeKey: string;
  /** NFC, 1 to MAX_PARAGRAPH_CODE_POINTS code points. */
  readonly paragraph: string;
};

export type RequestRule =
  | "body_too_large"
  | "body_not_utf8"
  | "body_bom"
  | "body_not_json"
  | "body_not_object"
  | "client_controlled_field"
  | "unknown_key"
  | "missing_key"
  | "invalid_assignment_id"
  | "invalid_conversation_id"
  | "invalid_catalog_version"
  | "invalid_purpose_key"
  | "paragraph_not_string"
  | "paragraph_lone_surrogate"
  | "paragraph_bom"
  | "paragraph_control"
  | "paragraph_invisible"
  | "paragraph_empty"
  | "paragraph_too_long"
  | "idempotency_key_missing"
  | "idempotency_key_invalid";

export type RequestRefusal = {
  readonly outcome: "invalid_request" | "invalid_idempotency_key";
  readonly rule: RequestRule;
};

export type ParseResult =
  | { readonly ok: true; readonly request: AssistantRequest }
  | ({ readonly ok: false } & RequestRefusal);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSE_KEY = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_INTEGER = 2_147_483_647;
// A high surrogate not followed by a low one, or a low one without a high one.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// C0 except tab (U+0009) and line feed (U+000A), DEL and C1.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;
// Byte order mark (zero-width no-break space) anywhere, marks and embedding,
// override and isolate controls that can hide text from the reader.
const INVISIBLE = /[﻿‎‏‪-‮⁦-⁩]/;
const BOM_BYTES = [0xef, 0xbb, 0xbf] as const;

function refuse(rule: RequestRule): ParseResult {
  const outcome = rule.startsWith("idempotency_key")
    ? "invalid_idempotency_key"
    : "invalid_request";
  return { ok: false, outcome, rule };
}

/** The canonical (lower-case) UUID, or null. */
export function canonicalUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

type ParagraphResult =
  { readonly ok: true; readonly text: string } | { readonly ok: false; readonly rule: RequestRule };

/** The paragraph rules of Z9 and Z10, on their own. */
export function parseParagraph(value: unknown): ParagraphResult {
  if (typeof value !== "string") return { ok: false, rule: "paragraph_not_string" };
  if (LONE_SURROGATE.test(value)) return { ok: false, rule: "paragraph_lone_surrogate" };
  if (value.startsWith("﻿")) return { ok: false, rule: "paragraph_bom" };
  if (CONTROL.test(value)) return { ok: false, rule: "paragraph_control" };
  if (INVISIBLE.test(value)) return { ok: false, rule: "paragraph_invisible" };
  const text = value.normalize("NFC");
  if (text.trim() === "") return { ok: false, rule: "paragraph_empty" };
  // The body limit bounds the text, so spreading it into code points is cheap.
  if ([...text].length > MAX_PARAGRAPH_CODE_POINTS)
    return { ok: false, rule: "paragraph_too_long" };
  return { ok: true, text };
}

function decodeBody(
  body: Uint8Array,
): { ok: true; value: unknown } | { ok: false; rule: RequestRule } {
  if (BOM_BYTES.every((byte, i) => body[i] === byte)) return { ok: false, rule: "body_bom" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body);
  } catch {
    return { ok: false, rule: "body_not_utf8" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, rule: "body_not_json" };
  }
}

/**
 * The request from the raw body bytes and the `Idempotency-Key` header, or
 * the first rule it breaks. Nothing here touches the database: a refusal
 * leaves no row and the key stays free.
 */
export function parseAssistantRequest(input: {
  readonly body: Uint8Array;
  readonly idempotencyKey: string | null | undefined;
}): ParseResult {
  const { body } = input;
  if (body.byteLength > MAX_REQUEST_BODY_BYTES) return refuse("body_too_large");
  if (
    input.idempotencyKey === null ||
    input.idempotencyKey === undefined ||
    input.idempotencyKey === ""
  ) {
    return refuse("idempotency_key_missing");
  }
  const idempotencyKey = canonicalUuid(input.idempotencyKey);
  if (idempotencyKey === null) return refuse("idempotency_key_invalid");

  const decoded = decodeBody(body);
  if (!decoded.ok) return refuse(decoded.rule);
  const value = decoded.value;
  if (!isPlainObject(value)) return refuse("body_not_object");
  if (!hasOnlyKeys(value, new Set(ASSISTANT_REQUEST_KEYS))) {
    const keys = Reflect.ownKeys(value);
    return refuse(
      keys.some((key) => typeof key === "string" && CLIENT_CONTROLLED_KEYS.includes(key))
        ? "client_controlled_field"
        : "unknown_key",
    );
  }
  if (!ASSISTANT_REQUEST_KEYS.every((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    return refuse("missing_key");
  }

  const assignmentId = canonicalUuid(ownProperty(value, "assignmentId"));
  if (assignmentId === null) return refuse("invalid_assignment_id");
  const rawConversation = ownProperty(value, "conversationId");
  const conversationId = rawConversation === null ? null : canonicalUuid(rawConversation);
  if (rawConversation !== null && conversationId === null) return refuse("invalid_conversation_id");
  const version = ownProperty(value, "purposeCatalogVersion");
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_INTEGER
  ) {
    return refuse("invalid_catalog_version");
  }
  const purposeKey = ownProperty(value, "purposeKey");
  if (typeof purposeKey !== "string" || !PURPOSE_KEY.test(purposeKey))
    return refuse("invalid_purpose_key");
  const paragraph = parseParagraph(ownProperty(value, "paragraph"));
  if (!paragraph.ok) return refuse(paragraph.rule);

  return {
    ok: true,
    request: {
      idempotencyKey,
      assignmentId,
      conversationId,
      purposeCatalogVersion: version,
      purposeKey,
      paragraph: paragraph.text,
    },
  };
}

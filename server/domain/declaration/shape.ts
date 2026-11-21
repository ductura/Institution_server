import { hasOnlyKeys, isPlainObject } from "../json/index.ts";

// Closed-shape helpers shared by the payload, the put body and the form file.

/** A plain object with exactly `keys`, all own enumerable data properties. */
export function dataObject(
  value: unknown,
  keys: ReadonlySet<string>,
): value is Record<string, unknown> {
  return (
    isPlainObject(value) &&
    hasOnlyKeys(value, keys) &&
    Reflect.ownKeys(value).length === keys.size &&
    Object.values(Object.getOwnPropertyDescriptors(value)).every(
      (d) => "value" in d && d.enumerable,
    )
  );
}

/** A plain dense array with no extra own properties, at most `max` items. */
export function dataArray(value: unknown, max: number): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (value.length > max) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1) return false;
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, i);
    if (d === undefined || !("value" in d) || !d.enumerable) return false;
  }
  return true;
}

export const keySet = (...keys: string[]): ReadonlySet<string> => new Set(keys);

const SHA256_HEX = /^[0-9a-f]{64}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const FORM_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CONTROL_OR_LONE_SURROGATE = /[\p{Cc}\p{Cs}]/u;

export const isSha256Hex = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v);
export const isCanonicalUuid = (v: unknown): v is string =>
  typeof v === "string" && CANONICAL_UUID.test(v);
export const isUuidV4 = (v: unknown): v is string => typeof v === "string" && UUID_V4.test(v);
export const isFormId = (v: unknown): v is string => typeof v === "string" && FORM_ID.test(v);
export const isPositiveInt = (v: unknown): v is number =>
  Number.isSafeInteger(v) && (v as number) >= 1;
export const isFormVersion = (v: unknown): v is number => isPositiveInt(v) && v <= 2_147_483_647;

/** As `documentId` of the submission receipt. */
export function isDocumentId(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length >= 1 &&
    v.length <= 256 &&
    v.trim() === v &&
    !CONTROL_OR_LONE_SURROGATE.test(v)
  );
}

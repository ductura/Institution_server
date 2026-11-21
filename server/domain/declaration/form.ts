import { canonicalizeJcs } from "../forensics/index.ts";
import { sha256Hex } from "./attachments.ts";
import type { DeclarationForm } from "./payload.ts";
import { parseCanonicalJson } from "./payload.ts";
import { dataObject, isFormId, isFormVersion, keySet } from "./shape.ts";
import { isFormText } from "./text.ts";

export const DECLARATION_FORM_SCHEMA = "ductura-declaration-form-v1" as const;
/** Local bound for the form text; the contract leaves the form to the faculty (OD-11). */
export const MAX_FORM_TEXT_CODE_POINTS = 20_000;

export type DeclarationFormFile = {
  formSchema: typeof DECLARATION_FORM_SCHEMA;
  formId: string;
  formVersion: number;
  text: string;
};

const FORM_FILE_KEYS = keySet("formSchema", "formId", "formVersion", "text");

export function isDeclarationFormFile(v: unknown): v is DeclarationFormFile {
  return (
    dataObject(v, FORM_FILE_KEYS) &&
    v.formSchema === DECLARATION_FORM_SCHEMA &&
    isFormId(v.formId) &&
    isFormVersion(v.formVersion) &&
    isFormText(v.text, MAX_FORM_TEXT_CODE_POINTS)
  );
}

export type FormFileParse =
  | { ok: true; file: DeclarationFormFile; form: DeclarationForm }
  | { ok: false; reason: "invalid_form_file" };

const NEWLINE = 0x0a;

/**
 * Reads one versioned form file (OD-11). The bytes must be the JCS of a
 * closed form object, optionally followed by one newline so editors can keep
 * the file. `formSha256` is the SHA-256 of the JCS bytes without that newline,
 * so the same form has one hash however the file ends.
 */
export function parseDeclarationFormFile(bytes: Uint8Array): FormFileParse {
  const body = bytes.at(-1) === NEWLINE ? bytes.subarray(0, -1) : bytes;
  const value = parseCanonicalJson(body);
  if (!isDeclarationFormFile(value)) return { ok: false, reason: "invalid_form_file" };
  return {
    ok: true,
    file: value,
    form: {
      formId: value.formId,
      formVersion: value.formVersion,
      formSha256: sha256Hex(canonicalizeJcs(value)),
    },
  };
}

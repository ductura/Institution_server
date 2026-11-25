/**
 * The institution's ISVU setting (SRV-V22-ISVU-PORT; Ductus
 * docs/nalazi/val22-razlika.md §3 t. 1).
 *
 * `config/faculties/<faculty>/isvu.json` is `{format: "ductura-faculty-isvu-v1",
 * mode: "off" | "mock"}`. The mode is `mock` only when the value is exactly
 * that object with `mode` exactly `"mock"`; anything else (a missing file, a
 * typo, an extra key, another format) is `off`. The type has no value for a
 * real connection, so one cannot be switched on by accident.
 *
 * Production is off and stays off: the constant changes only through the
 * owner's PR. This module reads a value or one file under a root it is given;
 * it reads no environment and opens no network.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { type IsvuPort } from "./port.ts";

export const ISVU_SETTING_FORMAT = "ductura-faculty-isvu-v1";
export const ISVU_SETTING_MAX_BYTES = 4 * 1024;
const FACULTY_SLUG = /^[a-z0-9-]{2,32}$/u;

export type IsvuMode = "off" | "mock";
export type IsvuSetting = { readonly mode: IsvuMode };

/** Off: the default for every institution. */
export const ISVU_SETTING_OFF: IsvuSetting = Object.freeze({ mode: "off" });

/** The production setting: off until the owner changes it by PR. */
export const PRODUCTION_ISVU_SETTING: IsvuSetting = ISVU_SETTING_OFF;

const MOCK: IsvuSetting = Object.freeze({ mode: "mock" });

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** The setting from a parsed configuration value; anything unexpected is off. */
export function readIsvuSetting(value: unknown): IsvuSetting {
  if (!isPlainObject(value)) return ISVU_SETTING_OFF;
  if (Object.getOwnPropertySymbols(value).length > 0) return ISVU_SETTING_OFF;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "format" || keys[1] !== "mode") return ISVU_SETTING_OFF;
  if (value.format !== ISVU_SETTING_FORMAT) return ISVU_SETTING_OFF;
  return value.mode === "mock" ? MOCK : ISVU_SETTING_OFF;
}

/**
 * The setting of one faculty from `<root>/<slug>/isvu.json`. A bad slug, a
 * missing, oversized or unreadable file, or invalid JSON is off.
 */
export function readIsvuSettingFile(root: string, slug: string): IsvuSetting {
  if (!FACULTY_SLUG.test(slug)) return ISVU_SETTING_OFF;
  try {
    const path = join(root, slug, "isvu.json");
    const metadata = statSync(path);
    if (!metadata.isFile() || metadata.size > ISVU_SETTING_MAX_BYTES) return ISVU_SETTING_OFF;
    return readIsvuSetting(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return ISVU_SETTING_OFF;
  }
}

/**
 * The port for a setting: the adapter when the mode is `mock`, otherwise
 * null, which a route answers with 404 so it does not reveal the integration.
 */
export function isvuPortFor(setting: IsvuSetting, adapter: IsvuPort | null): IsvuPort | null {
  return readIsvuSetting({ format: ISVU_SETTING_FORMAT, mode: setting?.mode }).mode === "mock"
    ? adapter
    : null;
}

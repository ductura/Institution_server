/**
 * The institution's setting for the AI assistant (SRV-1809, plan M9.0-S3;
 * D-267 O9, O10; owner decisions OC-1 and OC-2 of 21. 11. 2026.).
 *
 * Three flags: the assistant itself, transcription and provider tools. Each
 * is on only when it is exactly `true`; anything else is off, and so is a
 * missing or malformed setting. Transcription and tools count only when the
 * assistant is on. Web search runs only through Ductus's own tool with a
 * server-side destination list, which is empty for the pilot (OC-2); there is
 * no recording button.
 *
 * Production is off and stays off: the flag lives in the faculty
 * configuration and changes only through an owner's PR (OC-1). This module
 * only reads a value handed in; it reads no environment and no file.
 */
import { type InstitutionAiSwitch } from "../../domain/index.ts";

export type AssistantInstitutionSetting = {
  readonly enabled: boolean;
  readonly transcription: boolean;
  readonly tools: boolean;
};

const SETTING_KEYS: ReadonlySet<string> = new Set(["enabled", "transcription", "tools"]);

/** Every flag off: the default for every institution. */
export const ASSISTANT_SETTING_OFF: AssistantInstitutionSetting = Object.freeze({
  enabled: false,
  transcription: false,
  tools: false,
});

/** The production setting: off until the owner changes it by PR [OC-1]. */
export const PRODUCTION_ASSISTANT_SETTING: AssistantInstitutionSetting = ASSISTANT_SETTING_OFF;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The setting from a configuration value. A value that is not a plain object
 * with only the three known keys is off as a whole, so a typo cannot switch
 * anything on. A sub-flag is on only beside `enabled: true`.
 */
export function readAssistantSetting(value: unknown): AssistantInstitutionSetting {
  if (!isPlainObject(value)) return ASSISTANT_SETTING_OFF;
  if (Object.getOwnPropertySymbols(value).length > 0) return ASSISTANT_SETTING_OFF;
  if (!Object.keys(value).every((key) => SETTING_KEYS.has(key))) return ASSISTANT_SETTING_OFF;
  const enabled = Object.hasOwn(value, "enabled") && value.enabled === true;
  if (!enabled) return ASSISTANT_SETTING_OFF;
  return Object.freeze({
    enabled: true,
    transcription: Object.hasOwn(value, "transcription") && value.transcription === true,
    tools: Object.hasOwn(value, "tools") && value.tools === true,
  });
}

/** The switch the policy and the tools of server/domain/assistant read. */
export function institutionAiSwitchOf(setting: AssistantInstitutionSetting): InstitutionAiSwitch {
  const on = setting.enabled === true;
  return Object.freeze({
    transcription: on && setting.transcription === true,
    tools: on && setting.tools === true,
  });
}

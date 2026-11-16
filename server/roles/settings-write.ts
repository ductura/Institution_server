// The write of settings by level (S-1J-g, DAN-826-1a; contract Ductus#1836
// c.6916711449; D-297, D-298). The body of settings.values.put is checked
// against the route's contract and the settings catalogue before the port is
// called, so nothing the catalogue refuses reaches the database. Who may
// write which level, and the bounds of higher levels, the database decides
// (settings.set_value, DAN-801).
import { Value } from "@sinclair/typebox/value";

import { ROUTES } from "../contracts/index.ts";
import type { SettingsWriteOutcome, SettingsWriter, SettingWriteInput } from "../database/index.ts";
import { type AppError, boundOfFields, checkSettingWrite, type Result } from "../domain/index.ts";

const PUT_ID = "settings.values.put";
const schema = ROUTES.find((route) => route.id === PUT_ID)?.request.body;
if (schema === undefined) throw new Error(`no contract body ${PUT_ID}`);
const BODY = schema;

export type SettingsService = {
  /** The parsed JSON body of settings.values.put; a refusal never calls the port. */
  put(token: string, body: unknown): Promise<Result<SettingsWriteOutcome>>;
};

const refuse = (code: string): { ok: false; error: AppError } => ({
  ok: false,
  error: { code, messageKey: "errors.invalidInput" },
});

/** The write of a body, or the code of the first rule it breaks. */
function writeOf(body: unknown): Result<SettingWriteInput> {
  // Own data properties only: an object with a prototype is not a JSON body.
  const plain =
    typeof body === "object" && body !== null && Object.getPrototypeOf(body) === Object.prototype;
  if (!plain || !Value.Check(BODY, body)) return refuse("SETTING_INVALID_BODY");
  const fields = body as Omit<SettingWriteInput, "bound"> & {
    locked: boolean;
    min: number | null;
    max: number | null;
  };
  if ((fields.level === "course") !== (fields.course !== null))
    return refuse("SETTING_COURSE_MISMATCH");
  const bound = boundOfFields(fields);
  if (!bound.ok) return bound;
  const checked = checkSettingWrite({ ...fields, bound: bound.value });
  if (!checked.ok) return checked;
  const { level, course, key, value } = fields;
  return { ok: true, value: { level, course, key, value, bound: bound.value } };
}

export function createSettingsService(writer: SettingsWriter): SettingsService {
  return {
    async put(token, body) {
      const write = writeOf(body);
      if (!write.ok) return write;
      return { ok: true, value: await writer.setValue(token, write.value) };
    },
  };
}

// Service of server/profile: the interface language (DAN-851-1c2; contract
// Ductus#1836 c.6936456136, amended c.6938415428). Port of the deciding part of
// Ductus handleInterfaceLocalePost/Get (src/server/profile/interface-locale-
// route.ts at 51a062e), from decoding the body to the RPC, without a change of
// logic: the port gets only a valid UTF-8, canonical JSON body with exactly one
// valid locale. Size, deadline and Content-Length of the body stay in the route
// (DAN-851-1d); who the caller is comes only from the session token.
import {
  type AppError,
  canonicalizeJcs,
  type InterfaceLocale,
  parseInterfaceLocaleSetting,
  type Result,
} from "../domain/index.ts";
import type { InterfaceLocaleStore } from "../database/index.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** The body is not UTF-8 or not JSON at all. */
export const INTERFACE_LOCALE_INVALID_JSON = error(
  "INTERFACE_LOCALE_INVALID_JSON",
  "interfaceLocale.invalid_json",
);
/** JSON, but not canonical or not exactly one valid locale. */
export const INTERFACE_LOCALE_INVALID_BODY = error(
  "INTERFACE_LOCALE_INVALID_BODY",
  "interfaceLocale.invalid_body",
);
export const PROFILE_ERRORS: readonly AppError[] = [
  INTERFACE_LOCALE_INVALID_JSON,
  INTERFACE_LOCALE_INVALID_BODY,
];

export type ProfileService = {
  /** The caller's saved interface language, or null; the port's outcome as it is. */
  readInterfaceLocale(token: string): Promise<Result<InterfaceLocale | null>>;
  /** Saves the language in `bytes` (the body as received) and answers the saved value. */
  saveInterfaceLocale(token: string, bytes: Uint8Array): Promise<Result<InterfaceLocale>>;
};

const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });

/** The interface language service over the database port; it never throws on input. */
export function createProfileService(deps: { store: InterfaceLocaleStore }): ProfileService {
  return {
    readInterfaceLocale: (token) => deps.store.read(token),
    async saveInterfaceLocale(token, bytes) {
      let text: string;
      let value: unknown;
      try {
        // A byte order mark stays in the text, so it is refused like any other byte.
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        value = JSON.parse(text);
      } catch {
        return fail(INTERFACE_LOCALE_INVALID_JSON);
      }
      let canonical = false;
      try {
        canonical = canonicalizeJcs(value) === text;
      } catch {
        canonical = false;
      }
      const setting = canonical ? parseInterfaceLocaleSetting(value) : null;
      if (setting === null) return fail(INTERFACE_LOCALE_INVALID_BODY);
      return deps.store.save(token, setting.locale);
    },
  };
}

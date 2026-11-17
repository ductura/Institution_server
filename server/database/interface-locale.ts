// The interface language port (DAN-851-1c1; contract Ductus#1836
// c.6936040386). Port of rpc() and the saved-value check of Ductus
// src/server/profile/interface-locale-route.ts at 51a062e, without a change of
// logic: one withActor transaction per call, one statement, every row checked
// before it leaves this folder. Who the caller is comes from the session token
// inside identity.interface_locale() and identity.set_interface_locale(),
// never from a parameter. Unlike open-work.ts and replay-source.ts, which
// throw other errors on, this port is Ductus rpc(): every error becomes a
// Result with an AppError (docs/CODE_STYLE.md §8; text in locales/hr.json under
// `interfaceLocale`), and nothing is logged here. The SQLSTATE of a database
// error does not leave the port: its code is the closed DATABASE_ERROR.
import {
  type AppError,
  INTERFACE_LOCALE_SETTING_VALUES,
  type InterfaceLocale,
  type Result,
} from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** ZD401: no live session behind the token. */
export const INTERFACE_LOCALE_UNAUTHENTICATED = error(
  "INTERFACE_LOCALE_UNAUTHENTICATED",
  "interfaceLocale.unauthenticated",
);
/** ZD422 on a save: the database refused the value. */
export const INTERFACE_LOCALE_INVALID = error(
  "INTERFACE_LOCALE_INVALID",
  "interfaceLocale.invalid",
);
/** Not exactly one row, or a value outside the set (or not the one sent). */
export const INTERFACE_LOCALE_ROW_MALFORMED = error(
  "INTERFACE_LOCALE_ROW_MALFORMED",
  "interfaceLocale.row_malformed",
);
/** Any other error of the database or of withActor. */
export const INTERFACE_LOCALE_DATABASE_ERROR = error(
  "INTERFACE_LOCALE_DATABASE_ERROR",
  "interfaceLocale.database_error",
);
export const INTERFACE_LOCALE_ERRORS: readonly AppError[] = [
  INTERFACE_LOCALE_UNAUTHENTICATED,
  INTERFACE_LOCALE_INVALID,
  INTERFACE_LOCALE_ROW_MALFORMED,
  INTERFACE_LOCALE_DATABASE_ERROR,
];

/** The port the interface language route reads and saves through. */
export type InterfaceLocaleStore = {
  read(token: string): Promise<Result<InterfaceLocale | null>>;
  save(token: string, locale: InterfaceLocale): Promise<Result<InterfaceLocale>>;
};

// Spelled out in full, as in Ductus, so a search for "identity.<name>(" finds them.
const READ_SQL = "SELECT identity.interface_locale() AS locale";
const SET_SQL = "SELECT identity.set_interface_locale($1) AS locale";
const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });

function isLocale(value: unknown): value is InterfaceLocale {
  return (
    typeof value === "string" &&
    (INTERFACE_LOCALE_SETTING_VALUES as readonly string[]).includes(value)
  );
}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

/** The one row's locale, or the error of the call; never throws. */
async function rpc(
  withActor: WithActor,
  token: string,
  sql: string,
  params: unknown[],
): Promise<Result<unknown> | { ok: false; code: unknown }> {
  try {
    const result = await withActor(token, (tx) => tx.query<{ locale: unknown }>(sql, params));
    const rows: unknown = result.rows;
    if (!Array.isArray(rows) || rows.length !== 1) return fail(INTERFACE_LOCALE_ROW_MALFORMED);
    const row: unknown = rows[0];
    if (row === null || typeof row !== "object") return fail(INTERFACE_LOCALE_ROW_MALFORMED);
    return { ok: true, value: (row as { locale?: unknown }).locale };
  } catch (thrown) {
    return { ok: false, code: codeOf(thrown) };
  }
}

function failure(outcome: { ok: false; error: AppError } | { ok: false; code: unknown }) {
  if ("error" in outcome) return fail(outcome.error);
  return fail(
    outcome.code === "ZD401" ? INTERFACE_LOCALE_UNAUTHENTICATED : INTERFACE_LOCALE_DATABASE_ERROR,
  );
}

/** The interface language port over a withActor; it never throws. */
export function createInterfaceLocaleStore(withActor: WithActor): InterfaceLocaleStore {
  return {
    async read(token) {
      const read = await rpc(withActor, token, READ_SQL, []);
      if (!read.ok) return failure(read);
      if (read.value !== null && !isLocale(read.value)) return fail(INTERFACE_LOCALE_ROW_MALFORMED);
      return { ok: true, value: read.value };
    },
    async save(token, locale) {
      const saved = await rpc(withActor, token, SET_SQL, [locale]);
      if (!saved.ok) {
        if ("code" in saved && saved.code === "ZD422") return fail(INTERFACE_LOCALE_INVALID);
        return failure(saved);
      }
      // What the database saved must be what was sent; null or another value is not "saved".
      if (saved.value !== locale || !isLocale(saved.value))
        return fail(INTERFACE_LOCALE_ROW_MALFORMED);
      return { ok: true, value: locale };
    },
  };
}

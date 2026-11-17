// The interface language port (DAN-851-1c1; contract Ductus#1836
// c.6936040386). Port of rpc() and the saved-value check of Ductus
// src/server/profile/interface-locale-route.ts at 51a062e, without a change of
// logic: one withActor transaction per call, one statement, every row checked
// before it leaves this folder. Who the caller is comes from the session token
// inside identity.interface_locale() and identity.set_interface_locale(),
// never from a parameter. Unlike open-work.ts and replay-source.ts, which
// throw other errors on, this port is Ductus rpc(): every error becomes an
// outcome, and nothing is logged here; the reason is a closed code for the
// route's own record (DAN-851-1d), never for the answer.
import { INTERFACE_LOCALE_SETTING_VALUES, type InterfaceLocale } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

type Refusal =
  | { status: "unauthenticated" }
  /** The reason is row_malformed, a SQLSTATE or unknown; never a message. */
  | { status: "unavailable"; reason: string };

export type InterfaceLocaleRead = { status: "ok"; locale: InterfaceLocale | null } | Refusal;
export type InterfaceLocaleSave =
  { status: "ok"; locale: InterfaceLocale } | { status: "invalid" } | Refusal;

/** The port the interface language route reads and saves through. */
export type InterfaceLocaleStore = {
  read(token: string): Promise<InterfaceLocaleRead>;
  save(token: string, locale: InterfaceLocale): Promise<InterfaceLocaleSave>;
};

// Spelled out in full, as in Ductus, so a search for "identity.<name>(" finds them.
const READ_SQL = "SELECT identity.interface_locale() AS locale";
const SET_SQL = "SELECT identity.set_interface_locale($1) AS locale";
const SQLSTATE = /^[0-9A-Z]{5}$/;
const MALFORMED = { status: "unavailable", reason: "row_malformed" } as const;

function isLocale(value: unknown): value is InterfaceLocale {
  return (
    typeof value === "string" &&
    (INTERFACE_LOCALE_SETTING_VALUES as readonly string[]).includes(value)
  );
}

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(error: unknown): unknown {
  try {
    return error && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

type Outcome = { ok: true; value: unknown } | { ok: false; code: unknown };

async function rpc(
  withActor: WithActor,
  token: string,
  sql: string,
  params: unknown[],
): Promise<Outcome> {
  try {
    const result = await withActor(token, (tx) => tx.query<{ locale: unknown }>(sql, params));
    const rows: unknown = result.rows;
    if (!Array.isArray(rows) || rows.length !== 1) return { ok: false, code: MALFORMED };
    const row: unknown = rows[0];
    if (row === null || typeof row !== "object") return { ok: false, code: MALFORMED };
    return { ok: true, value: (row as { locale?: unknown }).locale };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
}

function refusal(code: unknown): Refusal {
  if (code === MALFORMED) return MALFORMED;
  if (code === "ZD401") return { status: "unauthenticated" };
  const reason = typeof code === "string" && SQLSTATE.test(code) ? code : "unknown";
  return { status: "unavailable", reason };
}

/** The interface language port over a withActor; it never throws. */
export function createInterfaceLocaleStore(withActor: WithActor): InterfaceLocaleStore {
  return {
    async read(token) {
      const read = await rpc(withActor, token, READ_SQL, []);
      if (!read.ok) return refusal(read.code);
      if (read.value !== null && !isLocale(read.value)) return MALFORMED;
      return { status: "ok", locale: read.value };
    },
    async save(token, locale) {
      const saved = await rpc(withActor, token, SET_SQL, [locale]);
      if (!saved.ok) return saved.code === "ZD422" ? { status: "invalid" } : refusal(saved.code);
      // What the database saved must be what was sent; null or another value is not "saved".
      if (saved.value !== locale || !isLocale(saved.value)) return MALFORMED;
      return { status: "ok", locale };
    },
  };
}

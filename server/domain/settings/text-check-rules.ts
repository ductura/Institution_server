// SRV-1101 (Val 11, C-12): which text checks the editor of an institution runs
// and which Lekta profile it shows. The identifiers are the kinds of the editor
// prototype (docs/prototip/editor/review2.js KEYS and app.js S.warn, as listed
// in INVENTAR-editor.md "Provjere u tekstu"); the content of the rule package
// is Daniel's official package once it is available, not this file.
// Pure: it reads nothing and imports only the profile list beside it.
import { LEKTA_PROFILE_IDS } from "./lekta-profiles.ts";

/** The text checks of the prototype, in the order of its list. */
export const TEXT_CHECK_IDS = [
  "paste",
  "claim",
  "long",
  "colloq",
  "absolute",
  "first",
  "passive",
  "term",
  "abbr",
  "trans",
  "short",
  "hole",
] as const;

export type TextCheckId = (typeof TEXT_CHECK_IDS)[number];

/** On without an institution profile: the prototype's S.warn defaults (hole is always on). */
const BASE: ReadonlySet<TextCheckId> = new Set<TextCheckId>([
  "paste",
  "claim",
  "long",
  "term",
  "abbr",
  "hole",
]);

/** Added when the institution has set a Lekta profile: the faculty then states the register. */
const WITH_PROFILE: ReadonlySet<TextCheckId> = new Set<TextCheckId>([
  "colloq",
  "absolute",
  "first",
]);

const PROFILES: ReadonlySet<string> = new Set(LEKTA_PROFILE_IDS);

/**
 * The Lekta profile an institution row holds, or null when none is set or the
 * stored value is not in the catalogue.
 */
export function lektaProfileOf(stored: unknown): string | null {
  return typeof stored === "string" && PROFILES.has(stored) ? stored : null;
}

/** The enabled checks for a profile (null: none set), in TEXT_CHECK_IDS order. */
export function enabledCheckIdsFor(profileId: string | null): TextCheckId[] {
  return TEXT_CHECK_IDS.filter(
    (id) => BASE.has(id) || (profileId !== null && WITH_PROFILE.has(id)),
  );
}

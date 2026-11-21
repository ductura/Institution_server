/**
 * The provider ban of D-194 t. 2, in code (plan #1662 P8; Ductus
 * docs/PRODUCT.md "Fakultet određuje dopuštene pružatelje i modele").
 *
 * Never allowed: a provider headquartered in China, a model developed by a
 * Chinese company (also when a European provider serves it) and processing
 * on servers in China. A faculty cannot switch any of this on, so the ban does
 * not live in configuration: a configuration entry that breaks it is not
 * loaded.
 *
 * Real provider and model names stay out of code and tests while the account
 * model and the provider are PRIJEDLOG (D-194 t. 6 and 7, O-1, Q-10). An entry
 * therefore declares the facts the ban is about, as ISO 3166-1 alpha-2 codes,
 * and the ban reads those facts. China here is CN together with HK and MO.
 */
import { hasOnlyKeys, isPlainObject } from "../json/index.ts";
import { MODEL_ID_PATTERN, PROVIDER_ID_PATTERN } from "./port.ts";

/** Jurisdictions the ban covers. A code, never a configurable list. */
export const BANNED_JURISDICTIONS: readonly string[] = Object.freeze(["CN", "HK", "MO"]);

export const PROVIDER_ENTRY_KEYS = Object.freeze([
  "headquarters",
  "modelDeveloperHeadquarters",
  "modelId",
  "processingCountries",
  "providerId",
] as const);

const COUNTRY = /^[A-Z]{2}$/;

export type ProviderEntry = {
  readonly providerId: string;
  readonly modelId: string;
  readonly headquarters: string;
  readonly modelDeveloperHeadquarters: string;
  readonly processingCountries: readonly string[];
};

export type ProviderEntryRule =
  | "invalid_entry"
  | "banned_provider_headquarters"
  | "banned_model_developer"
  | "banned_processing_location";

export type ProviderEntryResult =
  | { readonly ok: true; readonly entry: ProviderEntry }
  | { readonly ok: false; readonly rule: ProviderEntryRule };

function banned(country: string): boolean {
  return BANNED_JURISDICTIONS.includes(country);
}

/**
 * One provider and model entry of a faculty configuration, or the reason it
 * is not loaded. The shape is closed: an unknown key, a bad identifier or an
 * empty processing list is refused before the ban is read.
 */
export function parseProviderEntry(value: unknown): ProviderEntryResult {
  if (!isPlainObject(value) || !hasOnlyKeys(value, new Set(PROVIDER_ENTRY_KEYS))) {
    return { ok: false, rule: "invalid_entry" };
  }
  const { providerId, modelId, headquarters, modelDeveloperHeadquarters, processingCountries } =
    value;
  if (
    typeof providerId !== "string" ||
    !PROVIDER_ID_PATTERN.test(providerId) ||
    typeof modelId !== "string" ||
    !MODEL_ID_PATTERN.test(modelId) ||
    typeof headquarters !== "string" ||
    !COUNTRY.test(headquarters) ||
    typeof modelDeveloperHeadquarters !== "string" ||
    !COUNTRY.test(modelDeveloperHeadquarters) ||
    !Array.isArray(processingCountries) ||
    processingCountries.length === 0 ||
    !processingCountries.every((c): c is string => typeof c === "string" && COUNTRY.test(c))
  ) {
    return { ok: false, rule: "invalid_entry" };
  }
  if (banned(headquarters)) return { ok: false, rule: "banned_provider_headquarters" };
  if (banned(modelDeveloperHeadquarters)) return { ok: false, rule: "banned_model_developer" };
  if (processingCountries.some(banned)) return { ok: false, rule: "banned_processing_location" };
  return {
    ok: true,
    entry: {
      providerId,
      modelId,
      headquarters,
      modelDeveloperHeadquarters,
      processingCountries: Object.freeze([...processingCountries]),
    },
  };
}

/**
 * A faculty's provider list. One entry that breaks the ban or the shape
 * refuses the whole list: a configuration that breaks D-194 t. 2 is not
 * loaded, and an empty list means the assistant is off.
 */
export function parseProviderList(value: unknown):
  | { readonly ok: true; readonly entries: readonly ProviderEntry[] }
  | {
      readonly ok: false;
      readonly rule: ProviderEntryRule;
      readonly index: number;
    } {
  if (!Array.isArray(value)) return { ok: false, rule: "invalid_entry", index: -1 };
  const entries: ProviderEntry[] = [];
  for (const [index, raw] of value.entries()) {
    const result = parseProviderEntry(raw);
    if (!result.ok) return { ok: false, rule: result.rule, index };
    entries.push(result.entry);
  }
  return { ok: true, entries: Object.freeze(entries) };
}

# server/domain/profile

Tijelo postavke jezika sučelja, iz Ductusa `src/domain/profile/interface-locale-setting.ts` na `51a062e` (DAN-427; prijenos DAN-851-1a), bez promjene logike, s testovima. Izmjene: skup jezika je zamrznuti literal umjesto uvoza iz `@/lib/i18n/locale`, `interface` je `type` ([docs/CODE_STYLE.md](../../../docs/CODE_STYLE.md) §4) i uvozi imaju `.ts`.

- `INTERFACE_LOCALE_SETTING_VALUES`: zatvoreni, zamrznuti skup jezika sučelja (`hr`, `en`), isti kao CHECK `identity.user_preference.interface_locale` u bazi.
- `parseInterfaceLocaleSetting(value)`: vraća `{ locale }` samo za običan objekt (ili objekt bez prototipa) s točno jednim vlastitim ključem `locale` čija je vrijednost član skupa; sve ostalo je `null` (dodatni, simbolni ili neprebrojivi ključ, naslijeđeni `locale`, instanca klase, velika slova, regija, razmaci i nevidljivi znakovi). Kao u Ductusu, neprebrojiv ili getter `locale` prolazi; `JSON.parse` takav ne može proizvesti.

Ovo je jezik sučelja (D-70, F-06), ne jezik rada (`assignment`). Tko postavlja jezik dolazi iz sesije, nikad iz tijela.

Da je skup jednak jezicima koje sučelje nudi (`locales`) i da se slaže sa shemom i vektorima `profile.interface-locale.*`, provjerava unakrsni test `tests/contracts/interface-locale-domain.test.ts`.

Ne uvozi ništa.

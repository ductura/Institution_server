# locales

Tekstovi poruka i sučelja. Kod vraća samo ključ (`messageKey`, `docs/CODE_STYLE.md` §8), a tekst je ovdje.

- `hr.json`: ugniježđeni ključevi, npr. `gate.risk_below_floor`. Danas sadrži poruke razvojnog gatea (`scripts/engineering/risk-floor.ts`) i porta potpisa. Test `server/risk-floor.test.ts` provjerava da svaki ključ greške gatea ima tekst.
- `signing.*`: greške porta potpisa (`server/external/keys/signing-errors.ts`). Test `server/external/keys/signing-errors.test.ts` provjerava da svaki `messageKey` porta ima tekst.

## Katalog sučelja (S-1L.1, DAN-768)

- `hr.ts` i `en.ts` su izvor istine za tekstove sučelja. Preneseni su iz Ductusa `src/lib/i18n/messages.hr.ts` i `messages.en.ts` na `d52a92c3`. Mijenjana su samo četiri teksta, u oba jezika (zapisano odstupanje od prijenosa, `SOURCE_TEXT_CHANGES` u `source.ts`; odluka Ductus#1836 c.6889314023): radnje kopiranja ranijeg i neposlanog teksta sad govore o međuspremniku, jer `PRODUCT.md` §5 korijen „kopir-” dopušta samo u „Kopiraj navod”, „kopiranje navoda” i „Kopirano u međuspremnik”. U engleskom je i imenica „copy” (hrvatski „kopija”, koji nije korijen „kopir-”, ostaje) u jedanaest tekstova odjave `auth.*` postala „version” (nalaz reviewa ductura/server#38 c.6889516654). Digest izvora ostaje digest Ductusa; test ga uspoređuje nakon što vrati izvorne tekstove tih četiriju putanja. Šest hrvatskih ključeva preimenovano je u engleske (`SOURCE_KEY_RENAMES` u `source.ts`): `workspace.upute` → `workspace.instructions`, `workspace.rad` → `workspace.work`, `prijava` → `signIn`, `statusPage.states.radi|ne_radi|nije_ukljuceno` → `working|notWorking|notEnabled`.
- `Messages` je oblik tablice `hr`; `en` ga mora ispuniti (`satisfies Messages`), pa ključ koji nedostaje ruši typecheck. `MessageKey` su putanje do tekstova u `hr`, a `textOf(tablica, ključ)` čita tekst; ključ koji `hr` nema ne prolazi typecheck.
- Ključevi koji su vrijednosti s poslužitelja (vrste rada, stanja, pravila AI-ja) zadržavaju `snake_case`; zatvoreni popis je `LOCALE_KEYS` u `eslint.config.ts`.
- Testovi: `source.test.ts` (SHA-256 svih parova izvorna putanja i tekst jednak je onome iz izvora; konstante u `source.ts`; `@ts-expect-error` slučajevi za ključ koji nedostaje). Konstante digesta iz Ductus checkouta ponovno računa `pnpm tsx scripts/locales/source-digest.ts <ductus>`.

### Dug

- Zadatak je rezan na tri PR-a (Ductus#1836 c.6888942518). Slijede PR-a2 (`parity.ts` i `parity.test.ts`: isti ključevi, duljine popisa i `{placeholderi}` u `hr` i `en`) i PR-a3 (`messages.test.ts` i `messages-en.test.ts`: rječnik zabranjenih izraza, prijava samo AAI@EduHr, ime „Ductura”).
- Iz Ductus `messages.test.ts` nije prenesen slučaj „ne ponavlja tekst stanja spremanja iz `@/domain/sync/labels`”: tog modula ovdje nema. Vraća se sa zadatkom koji prenosi sync oznake.
- `messages-en.test.ts` (PR-a3) do prijenosa skenera (S-1L.1, PR-b) provjerava englesku kolonu rječnika kao popis korijena, a ne s `findForbiddenTerms` kao u Ductusu.

Tekstovi sučelja moraju poštovati rječnik zabranjenih izraza (Ductus `docs/PRODUCT.md` §5).

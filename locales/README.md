# locales

Tekstovi poruka i sučelja. Kod vraća samo ključ (`messageKey`, `docs/CODE_STYLE.md` §8), a tekst je ovdje.

- `hr.json`: ugniježđeni ključevi, npr. `gate.risk_below_floor`. Danas sadrži poruke razvojnog gatea (`scripts/engineering/risk-floor.ts`) i porta potpisa. Test `server/risk-floor.test.ts` provjerava da svaki ključ greške gatea ima tekst.
- `forbiddenTerms.*`: greške ulaza skenera zabranjenih izraza (`scripts/forbidden-terms/scan.ts`, `messageKey` po `docs/CODE_STYLE.md` §8). Test `scripts/forbidden-terms/scan.test.ts` provjerava da svaki kod greške ima tekst.
- `signing.*`: greške porta potpisa (`server/external/keys/signing-errors.ts`). Test `server/external/keys/signing-errors.test.ts` provjerava da svaki `messageKey` porta ima tekst.

## Katalog sučelja (S-1L.1, DAN-768)

- `hr.ts` i `en.ts` su izvor istine za tekstove sučelja. Preneseni su iz Ductusa `src/lib/i18n/messages.hr.ts` i `messages.en.ts` na `d52a92c3`. Mijenjana su samo četiri teksta, u oba jezika (zapisano odstupanje od prijenosa, `SOURCE_TEXT_CHANGES` u `source.ts`; odluka Ductus#1836 c.6889314023): radnje kopiranja ranijeg i neposlanog teksta sad govore o međuspremniku, jer `PRODUCT.md` §5 korijen „kopir-” dopušta samo u „Kopiraj navod”, „kopiranje navoda” i „Kopirano u međuspremnik”. U engleskom je i imenica „copy” (hrvatski „kopija”, koji nije korijen „kopir-”, ostaje) u jedanaest tekstova odjave `auth.*` postala „version” (nalaz reviewa ductura/server#38 c.6889516654). Digest izvora ostaje digest Ductusa; test ga uspoređuje nakon što vrati izvorne tekstove tih četiriju putanja. Šest hrvatskih ključeva preimenovano je u engleske (`SOURCE_KEY_RENAMES` u `source.ts`): `workspace.upute` → `workspace.instructions`, `workspace.rad` → `workspace.work`, `prijava` → `signIn`, `statusPage.states.radi|ne_radi|nije_ukljuceno` → `working|notWorking|notEnabled`.
- `Messages` je oblik tablice `hr`; `en` ga mora ispuniti (`satisfies Messages`), pa ključ koji nedostaje ruši typecheck. `MessageKey` su putanje do tekstova u `hr`, a `textOf(tablica, ključ)` čita tekst; ključ koji `hr` nema ne prolazi typecheck.
- Ključevi koji su vrijednosti s poslužitelja (vrste rada, stanja, pravila AI-ja) zadržavaju `snake_case`; zatvoreni popis je `LOCALE_KEYS` u `eslint.config.ts`.
- Testovi: `source.test.ts` (SHA-256 svih parova izvorna putanja i tekst jednak je onome iz izvora; konstante u `source.ts`; `@ts-expect-error` slučajevi za ključ koji nedostaje). Konstante digesta iz Ductus checkouta ponovno računa `pnpm tsx scripts/locales/source-digest.ts <ductus>`.

### Dug

- Zadatak je rezan na tri PR-a (Ductus#1836 c.6888942518). Slijede PR-a2 (`parity.ts` i `parity.test.ts`: isti ključevi, duljine popisa i `{placeholderi}` u `hr` i `en`) i PR-a3 (`messages.test.ts` i `messages-en.test.ts`: rječnik zabranjenih izraza, prijava samo AAI@EduHr, ime „Ductura”).
- Iz Ductus `messages.test.ts` nije prenesen slučaj „ne ponavlja tekst stanja spremanja iz `@/domain/sync/labels`”: tog modula ovdje nema. Vraća se sa zadatkom koji prenosi sync oznake.
- `messages-en.test.ts` (PR-a3) i dalje provjerava englesku kolonu rječnika kao popis korijena; uz njega sad radi skener (niže), koji čita oba jezika s `findForbiddenTerms` kao u Ductusu. Test ostaje kao dodatna provjera.

## Skener zabranjenih izraza (S-1L.1 PR-b2, DAN-768)

`scanLocales(root)` u `scripts/forbidden-terms/scan.ts` čita svaki tekst u `locales/`; pokreće ga `scripts/forbidden-terms/scan.test.ts` u `pnpm test` (ugovor Ductus#1836 c.6890523605, potvrda c.6890541239).

- Svaka datoteka u `locales/` mora biti na zatvorenom popisu: katalog (`CATALOGUES`: `hr.ts`, `en.ts`, `hr.json`) ili ne-katalog s razlogom (`NOT_CATALOGUES`, i `*.test.ts`). Nova datoteka ili podmapa ruši skener, pa novu datoteku treba razvrstati u `scan.ts`. `source.ts` je namjerno ne-katalog: čuva izvorne Ductus tekstove kao zapis.
- Iz `.ts` kataloga čita se vrijednost svakog izvoza (i popisi), ne izvorni kod; funkcija smije biti samo `textOf` u `hr.ts`. List koji nije string i dvaput napisan JSON ključ ruše skener. Test provjerava točan broj pročitanih tekstova (1375, 1375 i 28); kad se tekst doda ili makne, broj se mijenja u testu.
- Svaki tekst prolazi rječnik obaju jezika (`findForbiddenTerms`) i provjeru znakova (`unreadableCharacters`). U `en` nije dopušteno hrvatsko slovo, ni tekst jednak hrvatskom na istoj putanji, osim putanja na popisu `SAME_IN_BOTH` (imena i riječi iste u oba jezika).
- Iznimke su zatvoren popis `EXCEPTIONS`; danas samo doslovni „Risk:” u `hr.json` `gate.risk_invalid` i `gate.risk_below_floor` (ime retka u opisu PR-a). Zastarjela stavka `EXCEPTIONS` ili `SAME_IN_BOTH` ruši skener.

Tekstovi sučelja moraju poštovati rječnik zabranjenih izraza (Ductus `docs/PRODUCT.md` §5).

## Dodavanje jezika (S-1L.5, DAN-781)

Hrvatski je zadani jezik sučelja i uvijek se nudi, prvi. Drugi se jezik nudi samo kad je njegov katalog potpun prema `hr`: `OFFERED_LANGUAGES` u `parity.ts` računa se iz `offeredLanguages(messagesHr, INTERFACE_CATALOGUES)` pri učitavanju. Nepotpun katalog ispada iz ponude sam, bez ručnog isključivanja.

Katalog je potpun (`isCompleteCatalogue`) kad vrijedi sve od ovoga:

- ima svaki ključ iz `hr` i nijedan drugi, na istoj dubini (ugniježđen ključ koji `hr` nema je višak);
- svaki popis ima jednako stavki kao u `hr`, a gdje `hr` ima popis, i kandidat ima popis (ne tablicu s ključevima `0`, `1`…);
- svaki tekst ima iste `{placeholdere}` kao hrvatski;
- svaki tekst ima barem jedno vidljivo slovo, broj, interpunkciju ili simbol; razmaci, znakovi nulte širine, meka crtica, samostalni kombinirajući znakovi (npr. U+034F), znakovi privatne uporabe i prazna slova-ispune ne broje se;
- katalog se može pročitati do kraja (katalog koji baci grešku nije potpun).

Kandidat je samo kod od dva mala slova (ISO 639-1) različit od `hr`; unos `hr`, `HR`, ` hr` ili `hr-HR` se zanemaruje. Zadani jezik ne dolazi iz popisa kandidata, pa ga ni pogrešan unos ne može zamijeniti ni maknuti; popis koji se ne može pročitati ostavlja samo hrvatski. `INTERFACE_CATALOGUES` i `OFFERED_LANGUAGES` su zamrznuti.

### Postupak

1. Dodaj `locales/<kod>.ts` (kod jezika po ISO 639-1, npr. `de`) s izvozom `messages<Kod>` i `satisfies Messages`, po uzoru na `en.ts`. Typecheck ruši katalog kojem nedostaje ključ.
2. Upiši izvoz u `INTERFACE_CATALOGUES` u `parity.ts` i u `locales/index.ts`.
3. Razvrstaj novu datoteku u `CATALOGUES` skenera (`scripts/forbidden-terms/scan.ts`) s jezikom i imenom izvoza; nerazvrstana datoteka ruši skener. Rječnik zabranjenih izraza za taj jezik mora postojati prije nego što se jezik ponudi.
4. Ažuriraj očekivane vrijednosti u testovima: `Object.keys(INTERFACE_CATALOGUES)` i `OFFERED_LANGUAGES` u `available.test.ts` te broj pročitanih tekstova u `scripts/forbidden-terms/scan.test.ts`.

### Provjere prije PR-a

- `pnpm typecheck`: katalog ispunjava `Messages`.
- `pnpm test`: `available.test.ts` (jezik je u `OFFERED_LANGUAGES`), `parity.test.ts` i skener zabranjenih izraza.
- Ručno: `catalogueGaps(messagesHr, messages<Kod>)` vraća prazne `missing`, `extra` i `placeholders`; ako jezik nije u ponudi, to su razlozi.
- Jezik koji nije preveden do kraja ostaje izvan `INTERFACE_CATALOGUES` ili izvan ponude; djelomičan prijevod se ne nudi.

## Tekst u kodu servera (S-1L.2, DAN-780)

Lint pravilo `local/no-hardcoded-text` (`scripts/lint-rules/hardcoded-text.ts`) ruši tekst sučelja napisan u `server/**`. Kod vraća `{ code, messageKey }` (`docs/CODE_STYLE.md` §8), a tekst je ovdje.

- Pravilo čita svaki string literal i predložak, i kad je složen od dijelova koje vidi: predložak (i označeni), `+`, `.concat`, `String(x)`, grane `?:`, `??` i `||`, `as`, `satisfies`, niz (sa spreadom i separatorom `.join`), ime `const` vrijednosti, `String.fromCharCode` i `String.fromCodePoint` (i kroz `.apply`), `.source` regexa, oblik dekodiran iz postotnog zapisa, base64 i hex te rezultat `atob`, `Buffer.from` i `decodeURIComponent` nad tekstom koji vidi. Sklopljeni tekst dulji od `MAX_LENGTH` (4096) znakova je nepoznat i ne prijavljuje se (odluka c.6895834779); kratki base64 i hex literali dekodiraju se kao i dugi. Čita i imena (identifikatore). Tekst složen u izvođenju (petlja s `+=`, `.replace`, obrtanje, brojevne baze) ne vidi; to je granica opisana u zaglavlju pravila.
- Ruši tekst s ijednim slovom ili dijakritičkim znakom izvan ASCII-ja (hrvatska slova, i kao `\u` escape, rastavljena, homoglifi, puna širina) i rečenicu bez dijakritika: barem dvije riječi, od kojih je jedna hrvatska funkcijska riječ s popisa `STRONG_WORDS` („je”, „nije”, „se” ...) ili `WEAK_WORDS` (kratke riječi poput „ne”, „u”, „za”, koje vrijede samo malim slovima u tekstu koji počinje velikim slovom ili u tekstu velikim slovima, jer su i engleske ili tehničke).
- Dopušten je tehnički string u jednom komadu bez razmaka: ključ (`auth.signIn`), kod greške (`NOT_FOUND`), ime zaglavlja (`content-type`) i vrijednost na žici (`nije_ukljuceno`). Engleske poruke programskih pogrešaka pravilo ne razlikuje od teksta i ne ruši ih; njih, tekst složen u izvođenju i hrvatsku rečenicu bez riječi s popisa provjerava review.
- Iznimke su samo putanje, zatvoreni popis `TEXT_EXEMPT`: testovi (`server/**/*.test.ts`) i fixture `server/log/invented.fixture.ts`. Kod servera ne smije uvesti datoteku s tog popisa.
- Testovi: `tests/lint/hardcoded-text.test.ts` (RuleTester nad fixtureima i provjera konfiguracije repozitorija).
- Odstupanje od prihvata (otvoreno pitanje na Ductus#1836): `server/app.ts` još piše hrvatski tekst i na `CRITICAL_PATHS` je, pa ga ovaj `standard` zadatak ne mijenja. Do zadatka koji ga zamjenjuje (`server.ts` i `server/http`) stoji na zatvorenom popisu `TEXT_TRANSITIONAL`; test pada kad datoteka s popisa ne postoji ili više nema teksta. `server/index.ts` je bio na popisu dok ga DAN-775 (ductura/server#49) nije uklonio.
- Naslovi predloška README-a (`server/structure.ts`) čitaju se iz `docs/CODE_STYLE.md` §10, a odjeljci karte servera (`server/server-map.ts`) traže se po broju, pa ti alati ne pišu hrvatski tekst.

### Datoteke za izvlačenje pri prijenosu

Tekst iz koda koji se prenosi iz Ductusa prelazi u `locales/` u istom PR-u prijenosa; bez toga lint ne prolazi. Datoteke koje zadatak prijenosa pregledava (popis orkestratora za DAN-780 i inventar S-0.2):

| Datoteka u Ductusu                            | Zadatak prijenosa |
| --------------------------------------------- | ----------------- |
| `src/server/support/problem-report-route.ts`  | S-M-1             |
| `src/server/institution/student-workspace.ts` | S-M-3             |
| `src/server/projection/process-summary.ts`    | S-M-8             |
| ostale datoteke ruta iz inventara S-0.2       | S-M-1 … S-M-10    |

Stanje na Ductus `d52a92c3`: pravilo pokrenuto nad `src/server`, `src/application` i `app/api` (bez testova) ne nalazi nijedan tekst. Tri datoteke iz tablice vraćaju kodove (`{ error: "invalid_input" }`, `{ kind: "unauthorized" }`), a tekst tih kodova je u Ductusovom katalogu i klijentu; PR prijenosa uz kod prenosi i taj tekst u `locales/` ako ga sučelje prikazuje. Popis se dopunjuje kad zadatak prijenosa nađe novu datoteku.

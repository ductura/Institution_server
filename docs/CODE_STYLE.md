# Pravilnik koda

Pravila pisanja koda u `ductura/server`. Vrijede i za ostale Ductura repozitorije u TypeScriptu, osim gdje je izričito navedeno „web repozitoriji”. Dokument je na hrvatskom, kod i identifikatori na engleskom.

Svako pravilo navodi **provedbu**, tj. što ga provjerava:

- **lint**: ESLint pravilo iz `eslint.config.ts` (ili lokalno pravilo iz `scripts/lint-rules/`); `pnpm lint` s `--max-warnings 0` pada na svakom nalazu, a inline direktive su isključene;
- **formater**: automatsko formatiranje;
- **tipovi**: `tsc` sa strogim postavkama iz `tsconfig.json` (već vrijedi u CI-ju);
- **test**: automatski test u repou;
- **review**: samo ljudski ili agentski pregled PR-a.

Svi primjeri koriste izmišljene podatke (domena `.invalid`), nikad stvarne osobe ni radove.

## Pregled

| #   | Pravilo                                             | Provedba                                                                  |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | Datoteke u kebab-caseu                              | lint `local/kebab-case-filename` za `.ts`, ostalo review                  |
| 2   | `camelCase`, `PascalCase`, `UPPER_SNAKE`            | lint `@typescript-eslint/naming-convention` i `local/renamed-import-name` |
| 3   | Bez `any`                                           | lint `@typescript-eslint/no-explicit-any`; implicitni `any` hvata `tsc`   |
| 4   | `type` umjesto `interface`                          | lint `@typescript-eslint/consistent-type-definitions`                     |
| 5   | Bez `enum`                                          | lint `no-restricted-syntax`                                               |
| 6   | Uvoz samo kroz `index.ts`                           | lint `local/import-boundary` i `local/area-boundary`                      |
| 7   | Testovi uz kod, tri sufiksa                         | lint `local/test-file-suffix`, ostalo review                              |
| 8   | Jedan oblik rezultata i greške                      | review (tipovi kad se uvedu zajednički `Result`/`AppError`)               |
| 9   | `snake_case` u `camelCase` samo u `server/database` | lint `@typescript-eslint/naming-convention` (popisi imena), ostalo review |
| 10  | Svaka mapa ima `index.ts`, kod, testove i README    | test za `index.ts` i README, ostalo review                                |
| 11  | CSS moduli nose ime komponente                      | review (lint kad ga web repozitoriji uvedu)                               |
| 12  | Nove skripte u TypeScriptu                          | lint `local/only-ts`, `.sh` review                                        |
| 13  | Poveznice u dokumentima moraju vrijediti            | test                                                                      |

## 1. Datoteke u kebab-caseu

Imena datoteka i mapa su malim slovima, riječi odvojene crticom. Iznimke: dokumenti u korijenu i `docs/` u `UPPER_SNAKE.md` (`README.md`, `CODE_STYLE.md`) i datoteke koje alat traži pod fiksnim imenom (`.nvmrc`).

Provedba: lint `local/kebab-case-filename` za svaku `.ts` datoteku (svaki dio imena odvojen točkom je kebab-case). Imena mapa i ostalih datoteka čuva review.

Ispravno:

```text
server/session-store.ts
server/session-store.test.ts
```

Pogrešno:

```text
server/sessionStore.ts
server/Session_Store.ts
```

## 2. Imena: `camelCase`, `PascalCase`, `UPPER_SNAKE`

- vrijednosti (varijable, funkcije, parametri, svojstva): `camelCase`;
- tipovi i generički parametri: `PascalCase`;
- prave konstante na razini modula (nepromjenjiva vrijednost poznata pri učitavanju): `UPPER_SNAKE`.

Provedba: lint `@typescript-eslint/naming-convention` i `local/renamed-import-name`. Prvo pravilo ne gleda imenovani uvoz, pa drugo traži da lokalno ime preimenovanog uvoza (`import { a as b }`) javno ime preimenovanog izvoza (`export { a as b }`, i kad je napisano kao string), ime u `export * as ns` i ime u `import x = …` bude `camelCase`, `PascalCase` ili `UPPER_CASE`; ime preuzeto iz drugog modula bez preimenovanja (`import { snake_name }`) ostaje kakvo jest. Imena koja zadaje vanjski protokol ili alat su zatvoreni popisi u `eslint.config.ts`. Razliku između prave konstante i obične vrijednosti u `UPPER_SNAKE` čuva review.

Ispravno:

```ts
const MAX_SESSION_AGE_MS = 8 * 60 * 60 * 1000;
type SessionRecord = { userId: string; createdAt: number };
function isExpired(record: SessionRecord, now: number): boolean {
  return now - record.createdAt > MAX_SESSION_AGE_MS;
}
```

Pogrešno:

```ts
const maxSessionAge = 28800000; // konstanta nije UPPER_SNAKE
type session_record = { user_id: string }; // ni tip ni svojstvo
function IsExpired() {}
```

## 3. Bez `any`

Nepoznat oblik je `unknown`, pa se sužava provjerom. `any` gasi provjeru tipova i ne smije se pojaviti ni u testovima.

Provedba: lint `@typescript-eslint/no-explicit-any`. Implicitni `any` hvata `strict` u `tsconfig.json`.

Ispravno:

```ts
function parseBearer(header: unknown): string | null {
  if (typeof header !== "string") return null;
  return header.match(/^Bearer\s+(\S+)$/i)?.[1] ?? null;
}
```

Pogrešno:

```ts
function parseBearer(header: any) {
  return header.split(" ")[1];
}
```

## 4. `type` umjesto `interface`

Oblici podataka se pišu kao `type`. Jedan način pisanja, bez spajanja deklaracija i nenamjernog proširivanja.

Provedba: lint `@typescript-eslint/consistent-type-definitions` (`type`).

Ispravno:

```ts
type Doc = AccessDoc & { id: string; title?: string };
```

Pogrešno:

```ts
interface Doc extends AccessDoc {
  id: string;
}
```

## 5. Bez `enum`

Skup dopuštenih vrijednosti je unija stringovnih literala, po potrebi izvedena iz `as const` polja. `enum` stvara izvršni kod i nejasne brojčane vrijednosti.

Provedba: lint `no-restricted-syntax` za `TSEnumDeclaration` (i `const enum`).

Ispravno:

```ts
const ROLES = ["student", "mentor", "admin"] as const;
type Role = (typeof ROLES)[number];
```

Pogrešno:

```ts
enum Role {
  Student,
  Mentor,
  Admin,
}
```

## 6. Uvoz samo kroz `index.ts`

Iz druge mape uvozi se samo javno sučelje mape, tj. njezin `index.ts`. Unutarnje datoteke mape nisu dostupne izvana. Unutar iste mape datoteke se uvoze međusobno izravno. Uvozi imaju sufiks `.ts` (vrijedi `allowImportingTsExtensions`).

Provedba: lint `local/import-boundary` (druga mapa samo kroz njezin `index.ts`) i `local/area-boundary` (drugo područje samo kroz `server/<područje>/index.ts`).

Koja područja smiju uvoziti koja, propisuje tablica dopuštenih uvoza u [Karti servera](server-map.md#2-dopušteni-uvozi); provodi je lint `local/area-boundary` (S-1A-b), a `server/server-map.test.ts` provjerava da je tablica u pravilu jednaka karti i bez kruga.

Ispravno:

```ts
import { openSession } from "../auth/index.ts";
```

Pogrešno:

```ts
import { openSession } from "../auth/session-internal.ts";
```

## 7. Testovi uz kod

Test je u istoj mapi kao kod koji provjerava i ima isto ime plus sufiks. Sufiks određuje vitest projekt (`vitest.config.ts`):

| Sufiks                 | Projekt       | Što je                                  |
| ---------------------- | ------------- | --------------------------------------- |
| `.test.ts`             | `unit`        | čista logika, bez mreže i baze          |
| `.property.test.ts`    | `property`    | svojstveni testovi (fast-check)         |
| `.integration.test.ts` | `integration` | više dijelova skupa, HTTP, kasnije baza |

Provedba: lint `local/test-file-suffix` za datoteku koja po imenu izgleda kao test (`x.spec.ts`, `x.e2e.test.ts`), ostalo review. Datoteka s drugim sufiksom ili izvan mapa iz `vitest.config.ts` (`server/`, `test-support/`, `scripts/`, `tests/`) ne pripada nijednom projektu i tiho se ne pokreće, CI ostaje zelen; zato reviewer provjerava sufikse. Test se nikad ne briše ni preskače bez jednakovrijedne zamjene.

Prelazno: `server/smoke.test.ts` nema pripadni `smoke.ts` (dimni test cijelog kostura).

Ispravno:

```text
server/access.ts
server/access.test.ts
server/access.property.test.ts
```

Pogrešno:

```text
server/tests/access.spec.ts
server/access_test.ts
```

## 8. Jedan oblik rezultata i greške

Funkcija koja može očekivano zakazati vraća rezultat, ne baca iznimku. Greška uvijek ima oblik `{ code, messageKey }`: `code` je stabilan strojni kod (`UPPER_SNAKE`), `messageKey` ključ hrvatskog teksta u `locales/`. Tekst poruke nikad nije u kodu. Iznimke su rezervirane za programske pogreške (neispunjena pretpostavka), ne za ulaz korisnika.

```ts
type AppError = { code: string; messageKey: string };
type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
```

Provedba: review i `tsc`. Zajednički tipovi `Result` i `AppError` su u `server/domain/result.ts`. Prvi port koji ih koristi je `server/external/keys`; ostali se usklađuju uz zadatak koji ih mijenja.

Prelazno: `server/app.ts` još vraća `{ error: "..." }` s hrvatskim tekstom u kodu; prepisuje se uz zadatak koji ga mijenja.

Ispravno:

```ts
function readTitle(raw: unknown): Result<string> {
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, error: { code: "TITLE_REQUIRED", messageKey: "doc.title.required" } };
  }
  return { ok: true, value: raw.trim() };
}
```

Pogrešno:

```ts
function readTitle(raw: unknown): string {
  if (typeof raw !== "string") throw new Error("Naslov je obavezan"); // iznimka za ulaz, tekst u kodu
  return raw;
}
```

## 9. `snake_case` iz baze u `camelCase` samo na jednom mjestu

Stupci u bazi su `snake_case`. Pretvorba u `camelCase` događa se samo u `server/database` (mapiranje redaka u objekte i obrnuto). Ostatak koda nikad ne vidi `snake_case` i ne radi vlastite pretvorbe.

Provedba: lint `@typescript-eslint/naming-convention` odbija `snake_case`; imena iz baze (`DATABASE_NAMES`) dopušta samo u `server/database` i `tests/db`, a stupce koje čitaju testovi migracija (`COLUMN_NAMES`) kao zatvoren popis. Gdje se pretvorba radi čuva review.

Ispravno:

```ts
// server/database/map-document.ts
type DocumentRow = { owner_id: string; created_at: string };
export function mapDocument(row: DocumentRow): { ownerId: string; createdAt: string } {
  return { ownerId: row.owner_id, createdAt: row.created_at };
}
```

Pogrešno:

```ts
// server/documents/list.ts
const ownerId = row.owner_id; // snake_case izvan server/database
```

## 10. Svaka mapa: `index.ts`, kod, testovi, README

Svaka mapa s kodom ima:

- `index.ts` koji izvozi javno sučelje mape (pravilo 6);
- kod i testove uz njega (pravilo 7);
- `README.md` na hrvatskom prema predlošku niže.

Predložak README-a područja: naslov je put mape, zatim jedna rečenica s poveznicom na [Kartu servera](server-map.md), pa pet odjeljaka ovim redom. Sadržaj se prepisuje iz karte (§1 i §2), ne izmišlja.

```md
# server/<područje>

## Što radi

## Tko ga zove

## Koje podatke dira

## Što izvozi

## Što ne smije uvoziti
```

Provedba: test (`server/structure.test.ts`) za `index.ts` i `README.md` svakog područja koje u karti postoji i za naslove predloška u područjima s popisa u testu; ostalo review.

Prelazno: README-i područja nastali prije predloška (`session`, `database`, `log`, `config`, `domain`, `external/srce-auth`, `external/storage`, `external/keys`) prelaze na njega kad ih zadatak ionako mijenja; tada područje ulazi u popis u `server/structure.test.ts`. `server/` nema `README.md` (README u korijenu opisuje strukturu), a `server/index.ts` je ulazna točka, ne izvoz sučelja. Mape bez koda (`db/`, `locales/`, `test-support/`, `docs/`) trenutačno su prazne i README dobivaju kad dobiju sadržaj.

Ispravno:

```text
server/auth/
  index.ts
  session.ts
  session.test.ts
  README.md
```

Pogrešno:

```text
server/auth/
  session.ts          // nema index.ts, testa ni README-a
```

## 11. CSS moduli nose ime komponente

Samo web repozitoriji (u `ductura/server` nema CSS-a). Stilska datoteka ima isto ime kao komponenta uz koju stoji i nastavak `.module.css`. Klase unutar modula su `camelCase`.

Provedba: review; lint kad ga web repozitoriji uvedu.

Ispravno:

```text
save-indicator.tsx
save-indicator.module.css   /* .statusText { ... } */
```

Pogrešno:

```text
save-indicator.tsx
styles.css                  /* globalno, ime ne govori čije je */
```

## 12. Nove skripte u TypeScriptu

Nove skripte (alati, migracijska pomagala, provjere) pišu se u TypeScriptu i pokreću preko `tsx`, ne u `.sh`, `.js` ni `.mjs`. Jedini dopušteni shell su jednoredne naredbe u `package.json` i koraci u CI-ju.

Provedba: lint `local/only-ts` (`.js`, `.mjs`, `.cjs`, `.jsx`, `.tsx`, `.mts`, `.cts`, u bilo kojoj veličini slova); `.sh` i ostalo review.

Ispravno:

```text
scripts/check-links.ts      # pnpm tsx scripts/check-links.ts
```

Pogrešno:

```text
scripts/check-links.sh
scripts/check-links.js
```

## 13. Poveznice u dokumentima moraju vrijediti

Relativna poveznica (`[tekst](put)` ili definicija `[x]: put`) u `README.md` i `docs/**/*.md` mora pokazivati na postojeću datoteku (a sidro `#...` na postojeći naslov u toj datoteci).

Provedba: test (`server/docs-links.test.ts`). Pokriva inline poveznice i definicije referenci (`[x]: put`), a duplicirane naslove sufiksira kao GitHub (`-1`).

Ispravno:

```md
Vidi [Pravilnik koda](docs/CODE_STYLE.md).
```

Pogrešno:

```md
Vidi [Pravilnik koda](docs/CODE-STYLE.md).
```

## Kako se pravilo mijenja

Promjena pravilnika je zaseban PR s `docs:` prefiksom. Kad lint dobije novo pravilo, u tablici „Pregled” i u pripadnom odjeljku promijeni se redak „Provedba” u istom PR-u.

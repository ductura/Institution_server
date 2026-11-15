# Pravilnik koda

Pravila pisanja koda u `ductura/server`. Vrijede i za ostale Ductura repozitorije u TypeScriptu, osim gdje je izričito navedeno „web repozitoriji”. Dokument je na hrvatskom, kod i identifikatori na engleskom.

Svako pravilo navodi **provedbu**, tj. što ga provjerava:

- **planirano S-0.7**: ESLint pravilo još ne postoji (zaseban zadatak S-0.7); do uvođenja pravilo čuva review;
- **formater**: automatsko formatiranje;
- **tipovi**: `tsc` sa strogim postavkama iz `tsconfig.json` (već vrijedi u CI-ju);
- **test**: automatski test u repou;
- **review**: samo ljudski ili agentski pregled PR-a.

Svi primjeri koriste izmišljene podatke (domena `.invalid`), nikad stvarne osobe ni radove.

## Pregled

| #   | Pravilo                                             | Provedba                                                       |
| --- | --------------------------------------------------- | -------------------------------------------------------------- |
| 1   | Datoteke u kebab-caseu                              | planirano S-0.7, do tada review                                |
| 2   | `camelCase`, `PascalCase`, `UPPER_SNAKE`            | planirano S-0.7, do tada review                                |
| 3   | Bez `any`                                           | planirano S-0.7, do tada review (implicitni `any` hvata `tsc`) |
| 4   | `type` umjesto `interface`                          | planirano S-0.7, do tada review                                |
| 5   | Bez `enum`                                          | planirano S-0.7, do tada review                                |
| 6   | Uvoz samo kroz `index.ts`                           | planirano S-0.7, do tada review                                |
| 7   | Testovi uz kod, tri sufiksa                         | review (vitest pokreće samo ta tri sufiksa)                    |
| 8   | Jedan oblik rezultata i greške                      | review (tipovi kad se uvedu zajednički `Result`/`AppError`)    |
| 9   | `snake_case` u `camelCase` samo u `server/database` | review                                                         |
| 10  | Svaka mapa ima `index.ts`, kod, testove i README    | test za `index.ts` i README, ostalo review                     |
| 11  | CSS moduli nose ime komponente                      | review (lint kad ga web repozitoriji uvedu)                    |
| 12  | Nove skripte u TypeScriptu                          | review                                                         |
| 13  | Poveznice u dokumentima moraju vrijediti            | test                                                           |

## 1. Datoteke u kebab-caseu

Imena datoteka i mapa su malim slovima, riječi odvojene crticom. Iznimke: dokumenti u korijenu i `docs/` u `UPPER_SNAKE.md` (`README.md`, `CODE_STYLE.md`) i datoteke koje alat traži pod fiksnim imenom (`.nvmrc`).

Provedba: planirano S-0.7, do tada review.

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

Provedba: planirano S-0.7 (`@typescript-eslint/naming-convention`), do tada review.

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

Provedba: planirano S-0.7 (`no-explicit-any`), do tada review. Implicitni `any` već hvata `strict` u `tsconfig.json`.

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

Provedba: planirano S-0.7 (`consistent-type-definitions: type`), do tada review.

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

Prelazno: kostur (`server/access.ts`, `server/store.ts`) još ima `interface`. Prepisuje se kad ga zadatak ionako mijenja ili uz uvođenje pravila u S-0.7.

## 5. Bez `enum`

Skup dopuštenih vrijednosti je unija stringovnih literala, po potrebi izvedena iz `as const` polja. `enum` stvara izvršni kod i nejasne brojčane vrijednosti.

Provedba: planirano S-0.7 (`no-restricted-syntax` za `TSEnumDeclaration`), do tada review.

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

Provedba: planirano S-0.7 (`no-restricted-imports`), do tada review.

Koja područja smiju uvoziti koja, propisuje tablica dopuštenih uvoza u [Karti servera](server-map.md#2-dopušteni-uvozi) (provodi S-1A-b).

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

Provedba: review. Datoteka s drugim sufiksom ili izvan mapa iz `vitest.config.ts` (`server/`, `test-support/`, `scripts/`, `tests/`) ne pripada nijednom projektu i tiho se ne pokreće, CI ostaje zelen; zato reviewer provjerava sufikse. Test se nikad ne briše ni preskače bez jednakovrijedne zamjene.

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

Provedba: review.

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

Provedba: review.

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

Promjena pravilnika je zaseban PR s `docs:` prefiksom. Kad lint dobije novo pravilo (S-0.7), u tablici „Pregled” i u pripadnom odjeljku promijeni se redak „Provedba” u istom PR-u.

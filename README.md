# Ductura / server

Zajednički API za sva Ductura sučelja: prijava AAI@EduHr, ovlasti, baza i pozadinski poslovi.

## Preduvjeti

- Node.js 24 (`.nvmrc`; `engines` u `package.json` traži barem 24).
- pnpm 10 (`packageManager` u `package.json`; najlakše preko `corepack enable`).

## Pokretanje

```bash
pnpm install
pnpm build              # jedan ulaz server/server.ts -> jedna datoteka dist/server.js (esbuild)
pnpm start              # node --disallow-code-generation-from-strings dist/server.js (DAN-772); traži APP_DATABASE_URL, sluša na HOST:PORT (zadano 127.0.0.1:4000)
pnpm typecheck          # TypeScript strict, bez izlaznih datoteka
pnpm lint               # ESLint nad cijelim repoom, bez upozorenja
pnpm test               # unit, property i integration, jedan za drugim (bez baze)
pnpm test:unit
pnpm test:property
pnpm test:integration  # integracijski testovi; testne baze na PGliteu (test-support/database)
pnpm test:integration:pg # testovi ovlasti (*.pg.integration.test.ts) na pravom PostgreSQL-u; traže migrirane baze
pnpm test:database      # testovi migracija, zatim test:integration:pg; traže migrirane baze na 127.0.0.1:54329 i :54330 (posao database u CI-ju)
pnpm contracts:generate # ponovno generira server/contracts/generated i openapi/v1.json iz ugovora
pnpm contracts:breaking [ref] # ruši se kad ugovor lomi klijente openapi/v1.json na ref (zadano origin/main)
```

Kod je u TypeScriptu. Server se za pokretanje gradi u `dist/server.js` (`pnpm build`); skripte i testovi se pokreću izravno (Node 24, `tsx`), bez koraka prevođenja. Neispravna okolina zaustavlja pokretanje prije slušanja, s izlaznim kodom 1 i retkom koji imenuje varijablu, nikad vrijednost. Baza se pri pokretanju ne otvara.

## Struktura

| Mapa                | Sadržaj                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/`           | Kod poslužitelja i testovi uz njega                                                                                                                   |
| `openapi/`          | Objavljeni OpenAPI dokument `v1.json`, generiran iz ugovora                                                                                           |
| `server/contracts/` | Ugovor API-ja `/api/v1` (TypeBox): izvor validacije, OpenAPI-ja, tipova, klijenta i lažnog servera                                                    |
| `locales/`          | Hrvatski tekstovi sučelja i poruka (zasad samo poruke gatea, `locales/hr.json`)                                                                       |
| `db/`               | Migracije i pgTAP testovi (dimni test okruženja CI-ja `db/tests/`, matrica glavne baze `db/main/tests/`)                                              |
| `packages/`         | `@ductura/test-fakes`: lažne zamjene za testove (lažni OIDC, lažni server, sat, usluge, FIDO2); samo devDependency                                    |
| `test-support/`     | Ostala pomagala za testove (`test-idp/`, `fake-kms/`, `malformed-signatures/`)                                                                        |
| `docs/`             | Dokumentacija na hrvatskom; vidi [Pravilnik koda](docs/CODE_STYLE.md) i [Kartu servera](docs/server-map.md) (područja, dopušteni uvozi, tok zahtjeva) |
| `scripts/`          | Alati repoa (lokalna lint pravila, gate, CI u `scripts/ci/`)                                                                                          |
| `tests/`            | Testovi alata repoa (lint, formatiranje) i funkcionalni testovi nad `dist/server.js` (`tests/functional/`)                                            |

## Lint

`eslint.config.ts` provjerava cijeli repo. Ignorira samo izlaze alata (`node_modules/`, `dist/`, `coverage/`).

- Imena datoteka su kebab-case. Dopušten je samo `.ts`, a testovi završavaju na `.test.ts`, `.property.test.ts` ili `.integration.test.ts`.
- Imena su `camelCase`, `PascalCase` ili `UPPER_SNAKE`.
- Zabranjeni su `any`, `interface` (umjesto njega `type`) i `enum`.
- U drugu mapu uvozi se samo kroz njezin `index.ts`.
- Upravljački program baze (`pg`, `pg-*`, `postgres`) uvozi samo `server/database` i testovi baze u `tests/db/` (`no-restricted-imports` i `database-boundary/no-restricted-dynamic-imports`, iz Ductusa; testovi u `tests/lint/pg-import-boundary*.test.ts`). `snake_case` imena stupaca i postavki baze dopuštena su samo u tim dvjema mapama.
- Direktive u retku (`eslint-disable`) ne gase nijedno pravilo. Sama direktiva ruši `pnpm lint`.

Lokalna pravila su u `scripts/lint-rules/`, a testovi nad fixtureima u `tests/lint/rules.test.ts`.

## Formatiranje

Prettier (`.prettierrc.json`) formatira cijeli repo osim izlaza alata i generiranog koda (`.prettierignore`).

- `pnpm format` formatira, `pnpm format:check` samo provjerava; CI pokreće `pnpm format:check` i pada na neformatiranu datoteku.
- `pnpm install` postavlja lefthook (`lefthook.yml`): prije commita formatira staged datoteke i ponovno ih stavlja u commit. Datoteke koje nisu staged ne dira.
- ESLint ne provjerava oblik koda: `eslint-config-prettier` je zadnji blok u `eslint.config.ts` i gasi svako pravilo koje bi se sukobilo s Prettierom.

Testovi su u `tests/format/format.test.ts`.

## Testovi

Vitest ima pet projekata. Projekt određuje sufiks datoteke, a `database` mapa `tests/db`. Testovi su samo u `server/`, `test-support/` i `scripts/` (testovi lint pravila u `tests/`) sa sufiksom `.test.ts`; datoteka izvan toga ne pripada nijednom projektu i ne pokreće se. Projekt bez ijedne datoteke ruši pokretanje, zato `pnpm test` i CI pokreću projekte jedan po jedan.

| Projekt          | Datoteke                                                              | Što provjerava                                                                                                   |
| ---------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `unit`           | `{server,test-support,tests,scripts}/**/*.test.ts`                    | Pomoćne funkcije, memorijsku bazu, dimni test, lint pravila i formatiranje                                       |
| `property`       | `{server,test-support,tests,scripts}/**/*.property.test.ts`           | Svojstva pravila pristupa (fast-check)                                                                           |
| `integration`    | `{server,test-support,tests,scripts}/**/*.integration.test.ts`        | HTTP poslužitelj od zahtjeva do odgovora                                                                         |
| `database`       | `tests/db/**/*.integration.test.ts` (izuzeti iz `integration`)        | Migracije glavne baze, zaključavanje migracija i sloj baze (`withActor`, `openSession`) na pravom PostgreSQL-u   |
| `integration-pg` | `**/*.pg.integration.test.ts` (izuzeti iz `integration` i `database`) | Testovi ovlasti i paritet migracija PGlite/PostgreSQL ([test-support/database](test-support/database/README.md)) |

Funkcionalna provjera: korisnik može otvoriti svoj dokument, a pokušaj pristupa tuđem dokumentu bude odbijen.
Nad `dist/server.js` na stogu VS-1 pokriva je `pnpm test:functional` ([tests/functional](tests/functional/README.md), S-1H.3); stari kostur i dalje provjerava `server/app.integration.test.ts`.

Svi podaci u testovima su izmišljeni (`student-a@primjer.invalid`).

## CI

`.github/workflows/ci.yml` ima četiri posla: `scope` razvrstava promjene, `checks` pokreće typecheck, lint, formatiranje i tri vitest projekta, `database` podiže PostgreSQL 17 (ista glavna verzija kao produkcija, nativno iz PGDG repoa, bez Dockera) i pokreće pgTAP okruženja (`db/tests/*.sql`), zatim u drugom klasteru na `127.0.0.1:54329` stvara uloge iz `db/main/local/migrator.sql`, primjenjuje sve migracije kroz `scripts/db/migrate-locked.ts` i pokreće `pnpm test:database`, a nakon nativnog stoga (`pnpm db:up:native`) i pgTAP matricu glavne baze (`pnpm test:db:native`, `db/main/tests`). `ci-ok` je jedini zbirni status. PR u kojem su samo obični dokumenti (`docs/**/*.md`, `README.md`) preskače posao baze i prolazi `ci-ok`; pad bilo kojeg potrebnog posla ruši `ci-ok`. Akcije su prikvačene na puni SHA. Pravila razvrstavanja i zbirnog statusa su u [scripts/ci/README.md](scripts/ci/README.md).

## Stanje kostura

- Prijava: **privremena testna zamjena, ne način prijave.** Token je samo ID korisnika (`Authorization: Bearer student-a@primjer.invalid`), pa se svatko može predstaviti kao bilo tko. Smije se pokretati samo u testovima i lokalnom radu, nikad u nekom postavljenom okruženju. To nije AAI@EduHr: studenti se prijavljuju isključivo preko AAI@EduHr (D-09). Zamjenjuju je zadaci prijave (S-1E) sesijom nakon prijave AAI@EduHr.
- Lažni OIDC pružatelj (`packages/test-fakes/oidc/`, „Demo prijava”): samo lokalno i u CI-ju (D-09), računi su izmišljeni. Pokretanje: `pnpm exec tsx packages/test-fakes/oidc/server.ts` (zadano `http://localhost:8080`). `FAKE_OIDC_MODE` bira način rada: `success` (zadano), `refuse`, `expired`, `unavailable`. S `NODE_ENV` različitim od praznog, `development` i `test` ne pokreće se.
- Baza: memorijska (`server/store.ts`). Zamjenjuje je prava baza.
- Pozadinski poslovi: još nisu dodani.

## API

Ulaz `server/server.ts` danas montira samo `GET /api/v1/health`. Ostale rute u tablici ima samo stari kostur `server/app.ts`, koji ostaje kao dimni test do S-1H.3 i više se ne pokreće kao server.

| Metoda | Putanja              | Opis                                  |
| ------ | -------------------- | ------------------------------------- |
| GET    | `/api/v1/health`     | Provjera rada (`dist/server.js`)      |
| GET    | `/api/documents`     | Dokumenti prijavljenog korisnika      |
| GET    | `/api/documents/:id` | Jedan dokument (vlasnik ili suradnik) |
| PUT    | `/api/documents/:id` | Izmjena (samo vlasnik)                |

## Ugovor API-ja (`server/contracts/`)

Ugovor je izvor koda (DAN-736, Ductura U4). Svaka ruta ima shemu u `server/contracts/routes/`: ulaz (parametri putanje, upit, tijelo, vrsta i najveća veličina tijela), uspješne odgovore, greške (status, zatvoreni kod i ključ za locales `errors.<kod>`) i „tko smije” (`access`, zatvoren skup). „Tko smije” je deklaracija; ovlast i dalje odlučuje baza. `server/contracts` uvozi samo `@sinclair/typebox`.

`pnpm contracts:generate` iz ugovora piše u `server/contracts/generated/`: `validate.ts` (validatori ulaza), `types.ts`, `client.ts` (fetch klijent, radi i izvan preglednika) i `fake-server/` (lažni server, U8: zahtjev koji odgovara vektoru iz `server/contracts/vectors/` dobiva točno taj odgovor, a kad ih odgovara više, prvi po redu u datoteci ili onaj koji imenuje zaglavlje `x-ductura-fake-vector`; ruta bez odgovarajućeg vektora 501 `not_implemented`, kriva metoda 405, ostalo 404 `not_found`). Lažni server je samo za testove: `eslint.config.ts` zabranjuje njegov uvoz izvan testova, `server/test-server/` i `test-support/`, a `server/contracts/fake-server.test.ts` provjerava da ga ulazna točka ne doseže. Uz njih piše objavljeni OpenAPI 3.1 dokument `openapi/v1.json`. Generirane datoteke se commitaju; test pada kad se razlikuju od novog generiranja.

### Verzija i zaštita od lomljenja (DAN-737, Ductura U5)

`info.version` u `openapi/v1.json` je `glavna.manja.zakrpa` iz `server/contracts/version.ts`. Glavna verzija je ona iz `API_PREFIX` (`/api/v1`) i imena datoteke. Svaka promjena dokumenta traži višu verziju: nova ruta ili polje podiže manju, promjena teksta zakrpu.

Promjena koja lomi postojeće klijente nije dopuštena unutar iste glavne verzije. CI na svakom PR-u pokreće `pnpm contracts:breaking` prema ciljnoj grani. Zaštita je zatvorena prema zadanome (Ductus#87, c.6880838648): sheme se normaliziraju (sortirani ključevi, bez `description`, `example`, `examples` i `title`), a svaka preostala razlika postojeće rute, parametra, polja, statusa (i statusa greške), zaglavlja ili `x-*` ključa ruši CI, bez zaključivanja o tome sužava li ili proširuje (`anyOf`, `format`, ograničenja). Sigurne su samo: nova ruta ili metoda; novo neobavezno polje u odgovoru; novo neobavezno polje u zahtjevu kad je objekt i prije i poslije zatvoren (`additionalProperties: false`), jer ga nijedan stari zahtjev nije mogao poslati; promjena `description`, `example`, `examples` ili `title`. Nalaz je oblika `GET /api/v1/x <JSON pointer>: field removed`. Lomljiva promjena je nova glavna verzija, novi dokument i nova putanja.

Popis ruta je preslika inventara iz Ductusa (`server/contracts/inventory.ts`). Ruta izvan inventara ruši test. Ovaj korak pokriva 10 od 38 datoteka (platforma, prijava, jezik sučelja); ostalih 28 je u popisu `PENDING` i dobiva sheme u sljedećem PR-u. Popis se smije samo smanjivati.

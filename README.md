# Ductura / server

Zajednički API za sva Ductura sučelja: prijava AAI@EduHr, ovlasti, baza i pozadinski poslovi.

## Preduvjeti

- Node.js 24 (`.nvmrc`; `engines` u `package.json` traži barem 24).
- pnpm 10 (`packageManager` u `package.json`; najlakše preko `corepack enable`).

## Pokretanje

```bash
pnpm install
pnpm start              # samo lokalno: http://localhost:4000 (PORT mijenja priključak)
pnpm typecheck          # TypeScript strict, bez izlaznih datoteka
pnpm lint               # ESLint nad cijelim repoom, bez upozorenja
pnpm test               # sva tri vitest projekta, jedan za drugim
pnpm test:unit
pnpm test:property
pnpm test:integration
pnpm contracts:generate # ponovno generira server/contracts/generated iz ugovora
```

Kod je u TypeScriptu i pokreće se izravno preko `tsx`, bez koraka prevođenja.

## Struktura

| Mapa | Sadržaj |
|---|---|
| `server/` | Kod poslužitelja i testovi uz njega |
| `server/contracts/` | Ugovor API-ja `/api/v1` (TypeBox): izvor validacije, OpenAPI-ja, tipova, klijenta i lažnog servera |
| `locales/` | Hrvatski tekstovi sučelja i poruka (prazno) |
| `db/` | Migracije i pgTAP testovi (prazno) |
| `test-support/` | Zajednička pomagala za testove: lažni OIDC pružatelj (`fake-oidc/`) |
| `docs/` | Dokumentacija na hrvatskom; vidi [Pravilnik koda](docs/CODE_STYLE.md) i [Kartu servera](docs/server-map.md) (područja, dopušteni uvozi, tok zahtjeva) |
| `scripts/` | Alati repoa (lokalna lint pravila) |
| `tests/` | Testovi alata repoa (lint, formatiranje) |

## Lint

`eslint.config.ts` provjerava cijeli repo. Ignorira samo izlaze alata (`node_modules/`, `dist/`, `coverage/`).

- Imena datoteka su kebab-case. Dopušten je samo `.ts`, a testovi završavaju na `.test.ts`, `.property.test.ts` ili `.integration.test.ts`.
- Imena su `camelCase`, `PascalCase` ili `UPPER_SNAKE`.
- Zabranjeni su `any`, `interface` (umjesto njega `type`) i `enum`.
- U drugu mapu uvozi se samo kroz njezin `index.ts`.
- Direktive u retku (`eslint-disable`) ne gase nijedno pravilo. Sama direktiva ruši `pnpm lint`.

Lokalna pravila su u `scripts/lint-rules/`, a testovi nad fixtureima u `tests/lint/rules.test.ts`.

## Formatiranje

Prettier (`.prettierrc.json`) formatira cijeli repo osim izlaza alata i generiranog koda (`.prettierignore`).

- `pnpm format` formatira, `pnpm format:check` samo provjerava; CI pokreće `pnpm format:check` i pada na neformatiranu datoteku.
- `pnpm install` postavlja lefthook (`lefthook.yml`): prije commita formatira staged datoteke i ponovno ih stavlja u commit. Datoteke koje nisu staged ne dira.
- ESLint ne provjerava oblik koda: `eslint-config-prettier` je zadnji blok u `eslint.config.ts` i gasi svako pravilo koje bi se sukobilo s Prettierom.

Testovi su u `tests/format/format.test.ts`.

## Testovi

Vitest ima tri projekta. Projekt određuje sufiks datoteke. Testovi su samo u `server/` i `test-support/` (testovi lint pravila u `tests/`) sa sufiksom `.test.ts`; datoteka izvan toga ne pripada nijednom projektu i ne pokreće se. Projekt bez ijedne datoteke ruši pokretanje, zato `pnpm test` i CI pokreću projekte jedan po jedan.

| Projekt | Datoteke | Što provjerava |
|---|---|---|
| `unit` | `{server,test-support,tests}/**/*.test.ts` | Pomoćne funkcije, memorijsku bazu, dimni test, lint pravila i formatiranje |
| `property` | `{server,test-support,tests}/**/*.property.test.ts` | Svojstva pravila pristupa (fast-check) |
| `integration` | `{server,test-support,tests}/**/*.integration.test.ts` | HTTP poslužitelj od zahtjeva do odgovora |

Funkcionalna provjera: korisnik može otvoriti svoj dokument, a pokušaj pristupa tuđem dokumentu bude odbijen.
Pokriva je `server/app.integration.test.ts`.

Svi podaci u testovima su izmišljeni (`student-a@primjer.invalid`).

## Stanje kostura

- Prijava: **privremena testna zamjena, ne način prijave.** Token je samo ID korisnika (`Authorization: Bearer student-a@primjer.invalid`), pa se svatko može predstaviti kao bilo tko. Smije se pokretati samo u testovima i lokalnom radu, nikad u nekom postavljenom okruženju. To nije AAI@EduHr: studenti se prijavljuju isključivo preko AAI@EduHr (D-09). Zamjenjuju je zadaci prijave (S-1E) sesijom nakon prijave AAI@EduHr.
- Lažni OIDC pružatelj (`test-support/fake-oidc/`, „Demo prijava”): samo lokalno i u CI-ju (D-09), računi su izmišljeni. Pokretanje: `pnpm exec tsx test-support/fake-oidc/server.ts` (zadano `http://localhost:8080`). `FAKE_OIDC_MODE` bira način rada: `success` (zadano), `refuse`, `expired`, `unavailable`. S `NODE_ENV` različitim od praznog, `development` i `test` ne pokreće se.
- Baza: memorijska (`server/store.ts`). Zamjenjuje je prava baza.
- Pozadinski poslovi: još nisu dodani.

## API

| Metoda | Putanja | Opis |
|---|---|---|
| GET | `/health` | Provjera rada |
| GET | `/api/documents` | Dokumenti prijavljenog korisnika |
| GET | `/api/documents/:id` | Jedan dokument (vlasnik ili suradnik) |
| PUT | `/api/documents/:id` | Izmjena (samo vlasnik) |

## Ugovor API-ja (`server/contracts/`)

Ugovor je izvor koda (DAN-736, Ductura U4). Svaka ruta ima shemu u `server/contracts/routes/`: ulaz (parametri putanje, upit, tijelo, vrsta i najveća veličina tijela), uspješne odgovore, greške (status, zatvoreni kod i ključ za locales `errors.<kod>`) i „tko smije” (`access`, zatvoren skup). „Tko smije” je deklaracija; ovlast i dalje odlučuje baza. `server/contracts` uvozi samo `@sinclair/typebox`.

`pnpm contracts:generate` iz ugovora piše u `server/contracts/generated/`: `validate.ts` (validatori ulaza), `openapi.json` (OpenAPI 3.1), `types.ts`, `client.ts` (fetch klijent, radi i izvan preglednika) i `fake-server.ts` (ruta iz ugovora 501 dok ne dobije vektore, kriva metoda 405, ostalo 404 `not_found`). Generirane datoteke se commitaju; test pada kad se razlikuju od novog generiranja.

Popis ruta je preslika inventara iz Ductusa (`server/contracts/inventory.ts`). Ruta izvan inventara ruši test. Ovaj korak pokriva 10 od 38 datoteka (platforma, prijava, jezik sučelja); ostalih 28 je u popisu `PENDING` i dobiva sheme u sljedećem PR-u. Popis se smije samo smanjivati.

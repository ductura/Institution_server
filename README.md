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
pnpm test               # sva tri vitest projekta, jedan za drugim
pnpm test:unit
pnpm test:property
pnpm test:integration
```

Kod je u TypeScriptu i pokreće se izravno preko `tsx`, bez koraka prevođenja.

## Struktura

| Mapa | Sadržaj |
|---|---|
| `server/` | Kod poslužitelja i testovi uz njega |
| `locales/` | Hrvatski tekstovi sučelja i poruka (prazno) |
| `db/` | Migracije i pgTAP testovi (prazno) |
| `test-support/` | Zajednička pomagala za testove: lažni OIDC pružatelj (`fake-oidc/`) |
| `docs/` | Dokumentacija na hrvatskom (prazno) |

## Testovi

Vitest ima tri projekta. Projekt određuje sufiks datoteke. Testovi su samo u `server/` i `test-support/` sa sufiksom `.test.ts`; datoteka izvan toga ne pripada nijednom projektu i ne pokreće se. Projekt bez ijedne datoteke ruši pokretanje, zato `pnpm test` i CI pokreću projekte jedan po jedan.

| Projekt | Datoteke | Što provjerava |
|---|---|---|
| `unit` | `server/**/*.test.ts` | Pomoćne funkcije, memorijsku bazu i dimni test |
| `property` | `server/**/*.property.test.ts` | Svojstva pravila pristupa (fast-check) |
| `integration` | `server/**/*.integration.test.ts` | HTTP poslužitelj od zahtjeva do odgovora |

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

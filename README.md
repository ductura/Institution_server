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
pnpm test               # svi vitest projekti
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
| `test-support/` | Zajednička pomagala za testove (prazno) |
| `docs/` | Dokumentacija na hrvatskom (prazno) |

## Testovi

Vitest ima tri projekta. Projekt određuje sufiks datoteke:

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
- Baza: memorijska (`server/store.ts`). Zamjenjuje je prava baza.
- Pozadinski poslovi: još nisu dodani.

## API

| Metoda | Putanja | Opis |
|---|---|---|
| GET | `/health` | Provjera rada |
| GET | `/api/documents` | Dokumenti prijavljenog korisnika |
| GET | `/api/documents/:id` | Jedan dokument (vlasnik ili suradnik) |
| PUT | `/api/documents/:id` | Izmjena (samo vlasnik) |

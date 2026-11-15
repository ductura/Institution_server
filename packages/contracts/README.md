# @ductura/contracts

Ugovor API-ja `/api/v1` za klijente (preloader, web), U10 (DAN-742): klijent `createClient`, tipovi operacija, validatori ulaza (`VALIDATORS`, `validateInput`) i dokument `openapi/v1.json` (verzija API-ja je njegov `info.version`).

- Sve je generirano iz `server/contracts` (`pnpm contracts:generate`); paket ga samo ponovno izvozi ([index.ts](index.ts)).
- Bez vektora i bez lažnog servera: to su testne zamjene u `@ductura/test-fakes`.
- Glavna verzija paketa jednaka je glavnoj verziji `API_VERSION`.
- Objava: [scripts/release](../../scripts/release/README.md). U repou je paket `private`; objavljuje se samo pripremljena kopija.

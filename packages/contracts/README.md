# @ductura/contracts

Ugovor API-ja `/api/v1` za klijente (preloader, web), U10 (DAN-742): klijent `createClient`, tipovi operacija, validatori ulaza (`VALIDATORS`, `validateInput`) i dokument `openapi/v1.json` (verzija API-ja je njegov `info.version`).

- Sve je generirano iz `server/contracts` (`pnpm contracts:generate`); paket ga samo ponovno izvozi ([index.ts](index.ts)).
- Bez vektora i bez lažnog servera: to su testne zamjene u `@ductura/test-fakes`.
- Glavna verzija paketa nije niža od glavne verzije `API_VERSION` (DAN-869). Paket 2.0.0 nosi lomljive promjene TypeScript tipova (`SharedErrorCode`, `SHARED_ERRORS`, novi članovi postojećih tipova); API ostaje v1 (`API_VERSION` 1.x, rute `/api/v1`).
- Objava: [scripts/release](../../scripts/release/README.md). U repou je paket `private`; objavljuje se samo pripremljena kopija.

## Instalacija bez tokena (DAN-966)

Svaka objavljena verzija je i `.tgz` na javnom GitHub Releaseu oznake `contracts-v2.1.0`, pa instalacija ne traži token (GitHub Packages ga traži i za javne pakete):

```sh
pnpm add https://github.com/ductura/server/releases/download/contracts-v2.1.0/ductura-contracts-2.1.0.tgz
```

Tarball je isti onaj koji je `publish.yml` provjerio i objavio; njegov sha256 je u bilješci izdanja.

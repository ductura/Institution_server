# @ductura/contracts

Ugovor API-ja `/api/v1` za klijente (preloader, web), U10 (DAN-742): klijent `createClient`, tipovi operacija, validatori ulaza (`VALIDATORS`, `validateInput`) i dokument `openapi/v1.json` (verzija API-ja je njegov `info.version`).

- Sve je generirano iz `server/contracts` (`pnpm contracts:generate`); paket ga samo ponovno izvozi ([index.ts](index.ts)).
- Vektori ID-a rada (DAN-942): `@ductura/contracts/vectors/work-id.json`, podatak bez koda. Svaki vektor ima `name`, `check` (`isWorkId` ili `workIdFromPath`), `input` ili `repeat` (`text` ponovljen `count` puta, 1 do 1024), `accepted` i, za prihvaćen put, `id` (dekodirani ID). Klijent ih prolazi svojom provjerom; server isti JSON čita s diska u [work-id-vectors.test.ts](work-id-vectors.test.ts), koji odbija i datoteku s viškom, manjkom ili krivim poljem. Znakovi izvan ispisivog ASCII-ja su `\uXXXX` escape; neparni surogat (`\ud800`) JavaScript čita kao takav, a čitač izvan JS-a ga može zamijeniti ili odbiti. Vektor se ne preimenuje i ne briše. **Promjena presude postojećeg vektora je lomljiva promjena koju razina izdanja (`level.ts`) vidi samo kao patch**, pa traži vlasničku odluku.
- Katalog grešaka (DAN-928): `@ductura/contracts/errors/catalog.json`, podatak bez koda. `format` je `ductura-error-catalog-v1`; `errors` su unosi `ERROR_CATALOG` iz `server/http/error-catalog.ts` (status, `code`, `messageKey`, istim redom; 401 ima dva unosa, `unauthenticated` i `session_expired`, koji se bira po kodu), a `shared` su `SHARED_ERRORS` (kodovi koje smije vratiti svaka ruta), svaki i u `errors` s istim statusom i ključem. Tekst poruke je pod `messageKey` u `locales/`. Izvor je kod servera; [error-catalog.test.ts](error-catalog.test.ts) datoteku čita strogo i drži je jednakom serveru. Kod se ne preimenuje i ne briše bez lomljive promjene.
- Vektori ruta i lažni server nisu ovdje: to su testne zamjene u `@ductura/test-fakes`.
- Glavna verzija paketa nije niža od glavne verzije `API_VERSION` (DAN-869). Paket 2.0.0 nosi lomljive promjene TypeScript tipova (`SharedErrorCode`, `SHARED_ERRORS`, novi članovi postojećih tipova); API ostaje v1 (`API_VERSION` 1.x, rute `/api/v1`).
- Objava: [scripts/release](../../scripts/release/README.md). U repou je paket `private`; objavljuje se samo pripremljena kopija.

## Instalacija bez tokena (DAN-966)

Svaka objavljena verzija je i `.tgz` na javnom GitHub Releaseu oznake `contracts-v2.1.0`, pa instalacija ne traži token (GitHub Packages ga traži i za javne pakete):

```sh
pnpm add https://github.com/ductura/server/releases/download/contracts-v2.1.0/ductura-contracts-2.1.0.tgz
```

Tarball je isti onaj koji je `publish.yml` provjerio i objavio; njegov sha256 je u bilješci izdanja.

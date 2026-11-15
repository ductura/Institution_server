# @ductura/test-fakes

Lažne zamjene za testove servera i klijenata (U9, DAN-741). **Samo lokalno i u CI-ju (D-09).** Svi računi, ključevi i podaci su izmišljeni.

| Uvoz                              | Što                                                                                                          | Porijeklo                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `@ductura/test-fakes/oidc`        | Lažni AAI OIDC pružatelj, načini `success`, `refuse`, `expired`, `unavailable` ([README](oidc/README.md))    | premješten iz `test-support/` (S-0.16)                                         |
| `@ductura/test-fakes/fake-server` | Lažni server iz ugovora: vraća vektore, ostalo 501                                                           | ponovni izvoz `server/contracts/generated/fake-server/` (U8); generator ostaje |
| `@ductura/test-fakes/clock`       | `createFakeClock`: sat koji se pomiče samo s `advance`                                                       | novo                                                                           |
| `@ductura/test-fakes/services`    | `createFakeService`: vanjska usluga kao `fetch` bez porta, `ok`, `slow` (čeka lažni sat), `down`             | novo                                                                           |
| `@ductura/test-fakes/fido2`       | `createSoftwareAuthenticator`: softverski FIDO2 (ES256), `clone()` i `withForeignKey()` za negativne testove | novo                                                                           |
| `@ductura/test-fakes`             | sve gore                                                                                                     |                                                                                |

PGlite tvornica i lažna baza zapisa dolaze u zasebnom PR-u (U9-b).

## Granica prema produkciji

- Paket je `private` i u korijenskom `package.json` je samo u `devDependencies`.
- Uvoz bilo kojeg ulaza uz `NODE_ENV` izvan nepostavljenog, `development` i `test` baca grešku.
- Lint `local/no-fake-server-import` odbija `@ductura/test-fakes` i `packages/test-fakes/` u produkcijskom kodu.
- `boundary.test.ts` provjerava produkcijsko zatvorenje ovisnosti (`pnpm list --prod`) i da nijedna ne-testna datoteka u `server/` ne učitava paket.
- Uvoz podputa koji nije u `exports` pada.

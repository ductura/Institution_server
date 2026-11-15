# Lažni OIDC pružatelj („Demo prijava”)

Testno pomagalo: OIDC pružatelj s izmišljenim računima u obliku koji izdaje AAI@EduHr. Služi da se prijava može graditi i testirati bez AAI@EduHr. **Samo lokalno i u CI-ju (D-09).** Studenti se prijavljuju isključivo preko AAI@EduHr. Prenesen je iz Ductusa `infra/fake-oidc` (`d52a92c3`, DAN-729), a kasnije prelazi u `@ductura/test-fakes` (U9).

## Pokretanje

```bash
pnpm exec tsx packages/test-fakes/oidc/server.ts   # http://localhost:8080
```

| Varijabla                                  | Značenje                                                                                                                      |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                 | Mora biti nepostavljen, prazan, `development` ili `test`. Sve ostalo, uključujući `production`, zaustavlja pokretanje.        |
| `PORT`                                     | Cijeli broj od 0 do 65535, zadano 8080.                                                                                       |
| `ISSUER`                                   | Samo `localhost`, `127.0.0.1` ili `[::1]` (F-019).                                                                            |
| `REDIRECT_URI`, `POST_LOGOUT_REDIRECT_URI` | Popis odvojen zarezima, samo adrese na ovom računalu.                                                                         |
| `BACKCHANNEL_LOGOUT_URI`                   | Kamo pružatelj šalje token odjave.                                                                                            |
| `FAKE_OIDC_MODE`                           | `success` (zadano), `refuse` (povratak s `access_denied`), `expired` (tokeni vrijede 1 s), `unavailable` (svaki zahtjev 503). |

## Što izvozi (`index.ts`)

- `createFakeOidc(options)`: HTTP poslužitelj koji još ne sluša. Odbija pokretanje ako `NODE_ENV` ovog procesa nije lokalni, ako način rada nije poznat, ili ako issuer ili povratna adresa nisu na ovom računalu.
- `fakeOidcConfigFromEnv(env)` i `listenPort(value)`: port i postavke iz okoline.
- Računi: `ACCOUNTS` (`DEMO_ACCOUNTS`), `DEMO_HOME_ORG`, `DEMO_HOME_ORG_B`, `isDemoAccountId`, `findDemoAccount`, `demoAccountClaims`.
- `assertFakeOidcAllowed`, `FAKE_OIDC_MODES`, `fakeOidcMode` te zadane povratne adrese.

## Granice uvoza

- Uvozi samo Node, `oidc-provider` (devDependency) i datoteke iz ove mape.
- Ne uvozi ništa iz `server/`.
- Proizvodni kod (`server/`) ovo ne uvozi (`docs/server-map.md`). Smiju ga koristiti samo testovi i lokalni rad.

Svi računi, imena i ustanove su izmišljeni.

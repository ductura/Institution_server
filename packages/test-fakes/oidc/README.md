# Lažni OIDC pružatelj („Demo prijava”)

Testno pomagalo: OIDC pružatelj s izmišljenim računima u obliku koji izdaje AAI@EduHr. Služi da se prijava može graditi i testirati bez AAI@EduHr. **Samo lokalno i u CI-ju (D-09).** Studenti se prijavljuju isključivo preko AAI@EduHr. Prenesen je iz Ductusa `infra/fake-oidc` (`d52a92c3`, DAN-729); od U9 (DAN-741) je modul `@ductura/test-fakes/oidc`.

## Pokretanje

```bash
pnpm exec tsx packages/test-fakes/oidc/server.ts   # http://localhost:8080
```

| Varijabla                                  | Značenje                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                 | Mora biti nepostavljen, prazan, `development` ili `test`. Sve ostalo, uključujući `production`, zaustavlja pokretanje.          |
| `PORT`                                     | Cijeli broj od 0 do 65535, zadano 8080.                                                                                         |
| `ISSUER`                                   | Samo `localhost`, `127.0.0.1` ili `[::1]` (F-019).                                                                              |
| `REDIRECT_URI`, `POST_LOGOUT_REDIRECT_URI` | Popis odvojen zarezima, samo adrese na ovom računalu.                                                                           |
| `BACKCHANNEL_LOGOUT_URI`                   | Kamo pružatelj šalje token odjave.                                                                                              |
| `FAKE_OIDC_ACCOUNTS_FILE`                  | Neobavezno: JSON s imenovanim računima bilo koje domene (`simulated-accounts.ts`, [docs/LOKALNO.md](../../../docs/LOKALNO.md)). |
| `FAKE_OIDC_MODE`                           | `success` (zadano), `refuse` (povratak s `access_denied`), `expired` (tokeni vrijede 1 s), `unavailable` (svaki zahtjev 503).   |

## Računi bilo koje ustanove (Ductus#2028)

Uz demo račune stranica prijave ima obrazac: domena ustanove, uloga (`student` ili `nastavnik`) i neobavezno korisničko ime. Račun je oznaka `sim:<uloga>:<korisnik>@<domena>` i nosi sve što treba, pa pružatelj ne čuva stanje. Uloga `nastavnik` izdaje `hrEduPersonAffiliation` `djelatnik`. Imenovani računi iz `FAKE_OIDC_ACCOUNTS_FILE` pojavljuju se kao gumbi. Opis i oblik datoteke: [docs/LOKALNO.md](../../../docs/LOKALNO.md).

## Što izvozi (`index.ts`)

- `createFakeOidc(options)`: HTTP poslužitelj koji još ne sluša. Odbija pokretanje ako `NODE_ENV` ovog procesa nije lokalni, ako način rada nije poznat, ili ako issuer ili povratna adresa nisu na ovom računalu.
- `fakeOidcConfigFromEnv(env)` i `listenPort(value)`: port i postavke iz okoline.
- Računi: `ACCOUNTS` (`DEMO_ACCOUNTS`), `DEMO_HOME_ORG`, `DEMO_HOME_ORG_B`, `isDemoAccountId`, `findDemoAccount`, `demoAccountClaims`.
- Simulirani računi: `simulatedAccountFromForm`, `simulatedAccountId`, `parseSimulatedAccountId`, `simulatedAccountClaims`, `simulatedClaimsFor`, `parseSimulatedAccountsFile`, `readSimulatedAccountsFile`, `isSimulatedDomain`, `SIMULATED_ROLES`.
- `assertFakeOidcAllowed`, `FAKE_OIDC_MODES`, `fakeOidcMode` te zadane povratne adrese.

## Granice uvoza

- Uvozi samo Node, `oidc-provider` (devDependency) i datoteke iz ove mape.
- Ne uvozi ništa iz `server/`.
- Proizvodni kod (`server/`) ovo ne uvozi (`docs/server-map.md`). Smiju ga koristiti samo testovi i lokalni rad.
- Pokretanje kao ulazna točka sluša samo na `127.0.0.1` (ili `::1` za issuer `[::1]`), nikad na svim sučeljima (U9).
- Učitavanje `index.ts` uz `NODE_ENV` izvan dopuštenih vrijednosti baca grešku (U9).

Svi računi, imena i ustanove su izmišljeni.

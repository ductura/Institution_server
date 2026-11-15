# scripts/stack

Minimalni lokalni stog za VS-1 (DAN-759), jednom naredbom. **Samo lokalno i u CI-ju** (D-09): stog će pokretati lažni OIDC pružatelj. Ovaj korak ga još ne pokreće (rez iz ugovora: proces lažnog OIDC-a je `DAN-759 b`), ali blokada iz odjeljka niže već vrijedi.

```bash
pnpm build
pnpm stack:vs1 up [--env local|ci]   # PostgreSQL i server iz dist/server.js
pnpm stack:vs1 status                # datoteka stanja i health servera
pnpm stack:vs1 down                  # gasi što je up pokrenuo, provjerava da su portovi slobodni
```

Sve je u `.stack/vs1/` (u `.gitignore`):

- `pgdata/`: vlastiti PostgreSQL klaster (`initdb` i `pg_ctl` iz `PATH`), sluša samo na `127.0.0.1`, socket u `.stack/vs1/`. Provizija i migracije su iste kao `pnpm db:up:native` (`scripts/db/native-db.ts`); lozinka prijave `ductus` je u `pg-password` (0600). `initdb` ne radi kao root, pa stog odbija root.
- `server.log`, `postgres.log`: izlaz procesa.
- `state.json`: SHA repoa i oznaka promijenjenog stabla, verzije `@ductura/server`, `@ductura/contracts`, `@ductura/test-fakes`, `oidc-provider`, `pg` i Nodea, SHA-256 `dist/server.js`, okruženje, portovi i PID-ovi.

`up` čeka `GET /api/v1/health` = 200; ako bilo koji korak ne uspije, gasi što je već pokrenuo i izlazi s 1. `down` šalje SIGTERM (nakon 10 s SIGKILL) samo PID-ovima iz `state.json`, i samo dok naredbeni redak procesa još sadrži putanju s kojom je pokrenut; tuđi procesi i stogovi se ne diraju. Docker se ne koristi.

| Varijabla           | Zadano | Značenje                                         |
| ------------------- | ------ | ------------------------------------------------ |
| `VS1_POSTGRES_PORT` | 54360  | PostgreSQL                                       |
| `VS1_SERVER_PORT`   | 4100   | server                                           |
| `VS1_OIDC_PORT`     | 4180   | lažni OIDC pružatelj (rezerviran za `DAN-759 b`) |

Portovi 3000–3004 se odbijaju; zauzet port zaustavlja `up`.

## Blokada lažnog OIDC-a (D-09)

1. Okruženje dolazi samo iz argumenta: `local` (zadano) ili `ci`. Bilo što drugo, ponovljena ili nepoznata zastavica zaustavlja prije ijednog procesa (`config.ts`).
2. `NODE_ENV` pozivatelja mora biti prazan, `development` ili `test` (isti popis kao `assertFakeOidcAllowed`, test ih drži jednakima), za `local` i `ci` jednako.
3. Procesi dobivaju zadanu okolinu, ne pozivateljevu. Pružatelj sam odbija produkcijski `NODE_ENV` i adrese izvan ovog računala (`packages/test-fakes/oidc`); pokreće ga `DAN-759 b` s `NODE_ENV=test`.
4. Ništa iz `scripts/stack` ni `@ductura/test-fakes` ne ulazi u `dist/server.js` (test).

## Preloader i web

Isti origin: preloader na `/`, web na `/app/`. Ovdje su samo mjesta za priključak (`SLOTS` u `config.ts`, artefakt `null`); `up` ispisuje „not attached”. Popunjava ih nastavak, bez kloniranja drugih repoa.

## Testovi

`config.test.ts` (okruženja, `NODE_ENV`, portovi), `processes.test.ts` (gašenje samo vlastitih procesa, čekanje healtha, slobodan port), `state.test.ts` (SHA, verzije, datoteka 0600), `vs1.integration.test.ts` (skripta odbija bez pokretanja ičega; izgradnja servera ne sadrži stog ni lažni pružatelj). Cijeli stog na pravom PostgreSQL-u pokreće CI, posao „PostgreSQL i pgTAP”, korak „Stog VS-1”.

# scripts/stack

Minimalni lokalni stog za VS-1 (DAN-759), jednom naredbom. **Samo lokalno i u CI-ju** (D-09): stog će pokretati lažni OIDC pružatelj. Ovaj korak ga još ne pokreće, ali blokada iz odjeljka niže već vrijedi.

```bash
pnpm build
pnpm stack:vs1 up [--env local|ci]   # PostgreSQL i server iz dist/server.js
pnpm stack:vs1 down                  # gasi što je up pokrenuo, provjerava da su portovi slobodni
```

Sve je u `.stack/vs1/` (0700, u `.gitignore`):

- `pgdata/`: vlastiti PostgreSQL klaster (`initdb` i `pg_ctl` iz `PATH`). Sluša samo na `127.0.0.1`, a socket je u `.stack/vs1/` (0700). Provizija i migracije su iste kao `pnpm db:up:native` (`scripts/db/native-db.ts`). Lozinka prijave `ductus` je u `pg-password` (0600). `initdb` ne radi kao root, pa stog odbija root.
- `server.log`, `postgres.log`: izlaz procesa.
- `state.json`: SHA repoa i oznaka promijenjenog stabla, verzije `@ductura/server`, `@ductura/contracts`, `@ductura/test-fakes`, `oidc-provider`, `pg` i Nodea, SHA-256 `dist/server.js`, okruženje, portovi te PID i naredbeni redak servera.

## up

- `up` uzima `up.lock` s O_EXCL. Ako lock postoji, `up` odbija bez ikakve promjene. Zaostali lock (prekinut `up`) **nikad se ne preuzima automatski**: pokreni `pnpm stack:vs1 down`, zatim ga obriši ručno.
- Tek pod lockom `up` provjerava:
  - da nema stanja ni PostgreSQL-a ovog stoga;
  - da nije pokrenut kao root;
  - da postoji `dist/server.js`;
  - da je putanja sigurna: samo slova, znamenke, `.`, `_`, `-` i `/`, jer `pg_ctl` predaje `-o` ljusci, a socket ima najviše 107 bajtova;
  - da su portovi slobodni.
- Zatim čeka da `GET /api/v1/health` vrati 200 i provjerava da na portu sluša upravo pokrenuti server (`/proc`). Odgovor drugog procesa na istom portu, primjerice servera iz drugog checkouta, ne računa se kao spremnost. Stog zato radi samo na Linuxu (i WSL-u).
- Ako neki korak ne uspije, gasi samo ono što je taj poziv pokrenuo, uz PID servera iz memorije, i izlazi s 1.

## down

- Server dobiva SIGTERM, a nakon 10 s SIGKILL. Signal ide samo PID-u iz `state.json`, i to tek nakon nove provjere da je naredbeni redak točno onaj zapisani (`ps -ww`).
- PostgreSQL gasi `pg_ctl stop`, ali samo ako PID iz `postmaster.pid` pripada ovom klasteru.
- Ako `state.json` nedostaje ili nema potrebnu strukturu, `down` i dalje gasi PostgreSQL i provjerava portove iz `VS1_*` ili zadane.
- Tuđi procesi i stogovi se ne diraju. Docker se ne koristi.

## Portovi

| Varijabla           | Zadano | Značenje                                       |
| ------------------- | ------ | ---------------------------------------------- |
| `VS1_POSTGRES_PORT` | 54360  | PostgreSQL                                     |
| `VS1_SERVER_PORT`   | 4100   | server                                         |
| `VS1_OIDC_PORT`     | 4180   | lažni OIDC pružatelj (rezerviran za `DAN-787`) |

Portovi 3000–3004 se odbijaju.

## Blokada lažnog OIDC-a (D-09)

1. Okruženje dolazi samo iz argumenta: `local` (zadano) ili `ci`. Bilo što drugo, odnosno ponovljena ili nepoznata zastavica, zaustavlja prije ijednog procesa (`config.ts`).
2. `NODE_ENV` pozivatelja mora biti prazan, `development` ili `test`. To je isti popis kao u `assertFakeOidcAllowed`, a test ih drži jednakima.
3. Procesi dobivaju zadanu okolinu, ne pozivateljevu.
4. Ništa iz `scripts/stack` ni `@ductura/test-fakes` ne ulazi u `dist/server.js` (test).

## Izdvojeno u DAN-787

- proces lažnog OIDC-a;
- naredba `status`;
- automatski oporavak zaostalog locka;
- preloader (`/`) i web (`/app/`). Ovdje su samo mjesta za priključak (`SLOTS` u `config.ts`).

## Testovi

- `config.test.ts`: okruženja, `NODE_ENV` i portovi.
- `processes.test.ts`: gašenje samo vlastitih procesa, bez SIGKILL-a preuzetom PID-u, čekanje healtha i slobodan port.
- `state.test.ts`: SHA, verzije, datoteka 0600 i oštećeno stanje.
- `vs1.integration.test.ts`:
  - skripta odbija bez pokretanja ičega;
  - dok lock postoji, `up` odbija i ne dira stanje ni klaster;
  - `down` radi bez stanja ili sa stanjem iz memorije;
  - izgradnja servera ne sadrži stog ni lažni pružatelj.

Cijeli stog na pravom PostgreSQL-u pokreće CI, u poslu „PostgreSQL i pgTAP”, korak „Stog VS-1”.

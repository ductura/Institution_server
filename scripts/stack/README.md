# scripts/stack

Minimalni lokalni stog za VS-1 (DAN-759, DAN-787), jednom naredbom. **Samo lokalno i u CI-ju** (D-09): stog pokreće lažni OIDC pružatelj.

```bash
pnpm build
pnpm stack:vs1 up [--env local|ci]   # PostgreSQL, lažni OIDC i server iz dist/server.js
pnpm stack:vs1 down                  # gasi što je up pokrenuo, provjerava da su portovi slobodni
pnpm stack:vs1 status                # samo čita: stanje, procesi, health; izlaz 0 kad sve radi
```

Sve je u `.stack/vs1/` (0700, u `.gitignore`). `VS1_STACK_DIR` premješta cijeli stog; integracijski testovi tako koriste privremeni direktorij i nikad ne diraju lokalni `.stack/vs1`. Dopuštena je samo apsolutna staza od slova, znamenki, `.`, `_`, `-` i `/` unutar `.stack/` checkouta ili privremenog direktorija sustava, bez `.` i `..` i bez simboličke veze koja vodi van; inače `up`, `down` i `status` odbijaju prije ikakvog čitanja ili pisanja.

- `pgdata/`: vlastiti PostgreSQL klaster (`initdb` i `pg_ctl` iz `PATH`). Sluša samo na `127.0.0.1`, a socket je u `.stack/vs1/` (0700). Provizija i migracije su iste kao `pnpm db:up:native` (`scripts/db/native-db.ts`). Lozinka prijave `ductus` je u `pg-password` (0600). `initdb` ne radi kao root, pa stog odbija root.
- `server.log`, `oidc.log`, `postgres.log`: izlaz procesa.
- `state.json`: `repos` (SHA ovog repoa i oznaka promijenjenog stabla; `preloader` i `web` su `null` dok se utori ne priključe), verzije `@ductura/server`, `@ductura/contracts`, `@ductura/test-fakes`, `oidc-provider`, `pg`, Nodea i PostgreSQL-a, SHA-256 `dist/server.js`, okruženje, portovi te PID i naredbeni redak servera i lažnog OIDC-a.

## up

- `up` uzima `up.lock` s O_EXCL. Ako lock postoji, `up` odbija bez ikakve promjene. Zaostali lock (prekinut `up`) **nikad se ne preuzima automatski**: pokreni `pnpm stack:vs1 down`, zatim ga obriši ručno.
- Tek pod lockom `up` provjerava:
  - da nema stanja ni PostgreSQL-a ovog stoga;
  - da nije pokrenut kao root;
  - da postoji `dist/server.js`;
  - da je putanja sigurna: samo slova, znamenke, `.`, `_`, `-` i `/`, jer `pg_ctl` predaje `-o` ljusci, a socket ima najviše 107 bajtova;
  - da su portovi slobodni.
- Nakon PostgreSQL-a pokreće lažni OIDC (`packages/test-fakes/oidc/server.ts`) i čeka da `/.well-known/openid-configuration` vrati 200 iz upravo tog procesa. Server ne dobiva adresu issuera.
- Zatim čeka da `GET /api/v1/health` vrati 200 i provjerava da na portu sluša upravo pokrenuti server (`/proc`). Odgovor drugog procesa na istom portu, primjerice servera iz drugog checkouta, ne računa se kao spremnost. Stog zato radi samo na Linuxu (i WSL-u).
- Ako neki korak ne uspije, gasi samo ono što je taj poziv pokrenuo, uz PID-ove iz memorije, i izlazi s 1.

## down

- Server pa lažni OIDC dobivaju SIGTERM, a nakon 10 s SIGKILL. Signal ide samo PID-u iz `state.json`, i to tek nakon nove provjere da je naredbeni redak točno onaj zapisani (`ps -ww`).
- PostgreSQL gasi `pg_ctl stop`, ali samo ako PID iz `postmaster.pid` pripada ovom klasteru.
- Ako `state.json` nedostaje ili nema potrebnu strukturu, `down` i dalje gasi PostgreSQL i provjerava portove iz `VS1_*` ili zadane.
- Tuđi procesi i stogovi se ne diraju. Docker se ne koristi.

## status

- Ne uzima lock, ne stvara direktorij, ništa ne piše i ne poziva `git` (`git status` može osvježiti `.git/index`).
- Ispisuje stanje: repoe, verzije, odgovara li `dist/server.js` zapisanom SHA-256, PostgreSQL, server, lažni OIDC i lock.
- `GET` na health i discovery šalje samo procesu čiji je naredbeni redak točno zapisani i koji sam sluša na portu. Stanje s portom 3000–3004 je nečitljivo, pa takav port nikad ne pita.
- Izlaz 0 samo kad sva tri procesa rade i oba odgovora su 200; inače 1, i kad stog ne radi.

## Portovi

| Varijabla           | Zadano | Značenje             |
| ------------------- | ------ | -------------------- |
| `VS1_POSTGRES_PORT` | 54360  | PostgreSQL           |
| `VS1_SERVER_PORT`   | 4100   | server               |
| `VS1_OIDC_PORT`     | 4180   | lažni OIDC pružatelj |

Portovi 3000–3004 se odbijaju.

## Blokada lažnog OIDC-a (D-09)

1. Okruženje dolazi samo iz argumenta: `local` (zadano) ili `ci`. Bilo što drugo, odnosno ponovljena ili nepoznata zastavica, zaustavlja prije ijednog procesa (`config.ts`).
2. `NODE_ENV` pozivatelja mora biti prazan, `development` ili `test`. To je isti popis kao u `assertFakeOidcAllowed`, a test ih drži jednakima.
3. Procesi dobivaju zadanu okolinu, ne pozivateljevu. Lažni OIDC dobiva `NODE_ENV=test`, issuer na `127.0.0.1` i povratne adrese samo na server stoga; sam modul i dalje odbija učitavanje izvan dopuštenog `NODE_ENV`-a.
4. Server ne dobiva adresu lažnog issuera. Ništa iz `scripts/stack` ni `@ductura/test-fakes` ne ulazi u `dist/server.js` (test).

## Nije u stogu

- automatski oporavak zaostalog locka (lock ostaje `wx`, oporavak je ručan);
- preloader (`/`) i web (`/app/`): samo mjesta za priključak (`SLOTS` u `config.ts`), pa ni njihov SHA još nije zapisan.

## Testovi

- `config.test.ts`: okruženja, `NODE_ENV`, portovi i dopušteni direktorij stoga.
- `processes.test.ts`: gašenje samo vlastitih procesa, bez SIGKILL-a preuzetom PID-u, čekanje healtha i slobodan port.
- `state.test.ts`: SHA, verzije (i PostgreSQL), datoteka 0600, oštećeno stanje i portovi 3000–3004.
- `vs1.integration.test.ts`:
  - skripta odbija bez pokretanja ičega;
  - dok lock postoji, `up` odbija i ne dira stanje ni klaster;
  - `down` radi bez stanja ili sa stanjem iz memorije;
  - `status` samo čita: ne stvara direktorij, ne mijenja stanje ni lock, ne pita tuđi PID ni port 3000–3004;
  - lažni OIDC dobiva samo zadanu okolinu, a `down` ga gasi samo uz točan naredbeni redak;
  - izgradnja servera ne sadrži stog ni lažni pružatelj.

Cijeli stog na pravom PostgreSQL-u pokreće CI, u poslu „PostgreSQL i pgTAP”, korak „Stog VS-1”.

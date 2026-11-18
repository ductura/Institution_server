# scripts/stack

Minimalni lokalni stog za VS-1 (DAN-759, DAN-787), jednom naredbom. **Samo lokalno i u CI-ju** (D-09): stog pokreće lažni OIDC pružatelj.

```bash
pnpm build
pnpm stack:vs1 up [--env local|ci]   # PostgreSQL, lažni OIDC i server iz dist/server.js
pnpm stack:vs1 down                  # gasi što je up pokrenuo, provjerava da su portovi slobodni
pnpm stack:vs1 status                # samo čita: stanje, procesi, health; izlaz 0 kad sve radi
```

Sve je u `.stack/vs1/` (0700, u `.gitignore`). `VS1_STACK_DIR` premješta cijeli stog; integracijski testovi tako koriste privremeni direktorij i nikad ne diraju lokalni `.stack/vs1`. Dopuštena je samo apsolutna staza od slova, znamenki, `.`, `_`, `-` i `/` unutar `.stack/` checkouta ili `/tmp` (fiksno, ne iz `TMPDIR`), bez `.` i `..` i bez simboličke veze koja vodi van; inače `up`, `down` i `status` odbijaju prije ikakvog čitanja ili pisanja.

- `pgdata/`: vlastiti PostgreSQL klaster (`initdb` i `pg_ctl` iz `PATH`). Sluša samo na `127.0.0.1`, a socket je u `.stack/vs1/` (0700). Provizija i migracije su iste kao `pnpm db:up:native` (`scripts/db/native-db.ts`). Lozinka prijave `ductus` je u `pg-password` (0600). `initdb` ne radi kao root, pa stog odbija root.
- `server.log`, `oidc.log`, `postgres.log`: izlaz procesa.
- `state.json`: `repos` (SHA ovog repoa i oznaka promijenjenog stabla; `preloader` i `web` su `null` dok se utori ne priključe), verzije `@ductura/institution-server`, `@ductura/contracts`, `@ductura/test-fakes`, `oidc-provider`, `pg`, Nodea i PostgreSQL-a, SHA-256 `dist/server.js`, okruženje, portovi te PID i naredbeni redak servera i lažnog OIDC-a.

## up

- Prije `mkdir` i `chmod` postojeći direktorij stoga mora biti direktorij ovog korisnika, a ne simbolička veza.
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

- Server i lažni OIDC u naredbenom retku nose `--vs1-stack=<direktorij>`, pa `down` drugog stoga iz istog checkouta nikad ne pogađa njihov marker.
- Server pa lažni OIDC dobivaju SIGTERM, a nakon 10 s SIGKILL. Signal ide samo PID-u iz `state.json`, i to tek nakon nove provjere da je naredbeni redak točno onaj zapisani (`ps -ww`).
- PostgreSQL gasi `pg_ctl stop`, ali samo ako PID iz `postmaster.pid` pripada ovom klasteru.
- Ako `state.json` nedostaje ili nema potrebnu strukturu, `down` i dalje gasi PostgreSQL i provjerava portove iz `VS1_*` ili zadane.
- Tuđi procesi i stogovi se ne diraju. Docker se ne koristi.

## status

- Ne uzima lock, ne stvara direktorij, ništa ne piše i ne poziva `git` (`git status` može osvježiti `.git/index`).
- Ispisuje stanje: repoe, verzije, odgovara li `dist/server.js` zapisanom SHA-256, PostgreSQL, server, lažni OIDC i lock.
- `GET` na health i discovery šalje samo procesu čiji je naredbeni redak točno zapisani i koji sam sluša na portu. Preusmjeravanje se ne slijedi (ni u `up`). Stanje s portom 3000–3004 je nečitljivo, pa takav port nikad ne pita. `state.json` se čita samo kao obična datoteka do 64 KiB; kontrolni znakovi iz njega ne idu na terminal.
- Izlaz 0 samo kad sva tri procesa rade i oba odgovora su 200; inače 1, i kad stog ne radi.

## Portovi

| Varijabla           | Zadano | Značenje             |
| ------------------- | ------ | -------------------- |
| `VS1_POSTGRES_PORT` | 54360  | PostgreSQL           |
| `VS1_SERVER_PORT`   | 4100   | server               |
| `VS1_OIDC_PORT`     | 4180   | lažni OIDC pružatelj |
| `VS1_S3_PORT`       | 4191   | lokalni S3           |

Portovi 3000–3004 se odbijaju, kao i portovi koje `fetch` odbija (popis „bad ports”, npr. 4190): server do lokalnog S3 dolazi preko `fetch`.

Stanje `state.json` iz starijeg stoga bez porta `s3` čita se kao nečitljivo; tada `down` gasi samo PostgreSQL, a stare procese treba ugasiti ručno.

## Blokada lažnog OIDC-a (D-09)

1. Okruženje dolazi samo iz argumenta: `local` (zadano) ili `ci`. Bilo što drugo, odnosno ponovljena ili nepoznata zastavica, zaustavlja prije ijednog procesa (`config.ts`).
2. `NODE_ENV` pozivatelja mora biti prazan, `development` ili `test`. To je isti popis kao u `assertFakeOidcAllowed`, a test ih drži jednakima.
3. Procesi dobivaju zadanu okolinu, ne pozivateljevu. Lažni OIDC dobiva `NODE_ENV=test`, issuer na `127.0.0.1` i povratne adrese samo na server stoga; sam modul i dalje odbija učitavanje izvan dopuštenog `NODE_ENV`-a.
4. Server ne dobiva adresu lažnog issuera. Ništa iz `scripts/stack` ni `@ductura/test-fakes` ne ulazi u `dist/server.js` (test).

## Nije u stogu

- automatski oporavak zaostalog locka (lock ostaje `wx`, oporavak je ručan);
- preloader (`/`) i web (`/app/`): samo mjesta za priključak (`SLOTS` u `config.ts`), pa ni njihov SHA još nije zapisan.

## Dokazi na stogu (DAN-817)

`up` nakon provizije baze priprema pohranu dokaza i ključ potpisa (`evidence.ts`):

- Učitava izmišljene ustanove (`db/main/local/seed.sql`).
- Stvara razvojno sjeme ključa potpisa (32 bajta, `0600`, nikad se ne prepisuje). Sjeme je izvan checkouta, jer ga potpisnik unutar repozitorija odbija. Kad je stog u `.stack/vs1`, sjeme je u `$HOME/.ductura/stack-vs1-<hash direktorija>/signing-seed`; kad je stog izvan repozitorija (testovi u `/tmp`), sjeme je u direktoriju stoga.
- Javni ključ registrira kao ključ potvrda domene dokaza ustanove `demo-fakultet` (`db/main/local/evidence-signing-key.sql`, preko socketa stoga).
- Upisuje oznaku identiteta bucketa u `.stack/vs1/s3/` i pokreće lokalni S3 na `VS1_S3_PORT` (zadano 4191).
- Za svaki `up` stvara nove S3 vjerodajnice. One su samo u okolini procesa lokalnog S3 i servera, nikad na disku, u `state.json` ni u argv.

Server stoga dobiva `NODE_ENV=development`, `EVIDENCE_STORAGE_DOMAINS`, `EVIDENCE_S3_VS1_KEY_ID`, `EVIDENCE_S3_VS1_SECRET` i `DUCTUS_DEV_SIGNING_KEY_FILE`, a čita ih proizvodnim putem (`server/http/evidence-deps.ts`). Adresu lažnog OIDC-a i dalje ne dobiva. S istim varijablama, a s `NODE_ENV` izvan `development` i `test`, potpisnik odbija potpisivanje i pohrane nema, pa server na `evidence/commit` odgovara 503 (test u `evidence.test.ts`).

`node scripts/stack/vs1-commit-check.ts` (nakon `up`; CI ga pokreće u koraku „Stog VS-1”) upisuje izmišljenog studenta, kolegij i zadatak u demo-fakultet, zatim `evidence/open` i `evidence/commit` na serveru stoga traže 200 s potpisanom potvrdom koja prolazi provjeru ključevima iz `open` i novim objektom u lokalnom S3; isti `dist/server.js` s istim varijablama i `NODE_ENV=production` mora dati 503 i ne smije ništa spremiti.

`down` gasi i lokalni S3, uz točan marker naredbenog retka. `status` za njega provjerava samo sluša li upravo taj PID na svom portu.

## Lokalni S3 (DAN-817)

`local-s3.ts` je mali S3-kompatibilan proces za pohranu dokaza na stogu, bez Dockera. Samo lokalno i u CI-ju: odbija start ako `NODE_ENV` nije `development` ili `test`, sluša samo na `127.0.0.1`, a objekte drži kao datoteke u `VS1_S3_ROOT`, pa preživljavaju ponovno pokretanje servera.

- Odgovara samo na ono što traži `S3EvidencePayloadStore`: `GET`, `HEAD` i `PUT` koji samo stvara (`If-None-Match: *`, zapis preko privremene datoteke i tvrde veze, pa postojeći ključ daje 412). Vraća eho `x-amz-checksum-sha256` i `NoSuchKey`.
- Svaki zahtjev mora biti potpisan SigV4 ključem iz `EVIDENCE_S3_VS1_KEY_ID` i `EVIDENCE_S3_VS1_SECRET`; potpis se računa ponovno, a tijelo se provjerava prema potpisanom hashu i checksumu.
- Putanja je samo `[A-Za-z0-9._-]` po segmentu, bez `.`, `..`, upita i praznih segmenata; simbolička veza u direktoriju pohrane se ne slijedi.
- Server do njega dolazi samo kroz `EVIDENCE_STORAGE_DOMAINS` i proizvodni adapter. U produkciji adapter odbija http, pa lokalni S3 nikad nije pohrana produkcije.

## Testovi

- `config.test.ts`: okruženja, `NODE_ENV`, portovi i dopušteni direktorij stoga.
- `processes.test.ts`: gašenje samo vlastitih procesa, bez SIGKILL-a preuzetom PID-u, čekanje healtha i slobodan port.
- `state.test.ts`: SHA, verzije (i PostgreSQL), datoteka 0600, oštećeno stanje i portovi 3000–3004.
- `evidence.test.ts`: sjeme izvan checkouta, `0600` i bez prepisivanja; nove S3 vjerodajnice za svaki `up`; oznaka bucketa; točne varijable servera. Uz produkcijski `NODE_ENV` server ne dobiva ni razvojni potpisnik ni lokalni S3 (503), a nema ni OIDC issuera (D-09).
- `evidence.integration.test.ts`: adapter pohrane servera, iz okoline koju stog daje serveru, sprema i ponovno nalazi objekt kroz lokalni S3; potpisnik pod development potpisuje sjemenom stoga.
- `ports.integration.test.ts`: nijedan zadani port nije onaj koji `fetch` odbija („bad port”), a 4190 jest.
- `local-s3.integration.test.ts`: ugovorni test lokalnog S3 s pravim `S3EvidencePayloadStore` (stored, existing, conflict, čitanje, HEAD, identitet bucketa), odbijeni potpisi, putanje, veze, granica tijela i istodobni zapis, te odbijanje u produkciji (ductura/Institution_server#129, S1–S9, P1, P3).
- `vs1.integration.test.ts`:
  - skripta odbija bez pokretanja ičega;
  - dok lock postoji, `up` odbija i ne dira stanje ni klaster;
  - `down` radi bez stanja ili sa stanjem iz memorije;
  - `status` samo čita: ne stvara direktorij, ne mijenja stanje ni lock, ne pita tuđi PID ni port 3000–3004;
  - lažni OIDC dobiva samo zadanu okolinu, a `down` ga gasi samo uz točan naredbeni redak;
  - izgradnja servera ne sadrži stog ni lažni pružatelj.

Cijeli stog na pravom PostgreSQL-u pokreće CI, u poslu „PostgreSQL i pgTAP”, korak „Stog VS-1”.

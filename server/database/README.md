# server/database

Područje baze (karta: [docs/server-map.md](../../docs/server-map.md)). Jedino mjesto koje uvozi upravljački program baze (`pg`), kao Ductus `src/server/db/`; ESLint (`no-restricted-imports` i `database-boundary/no-restricted-dynamic-imports`) to provjerava za ostatak repoa, osim testova baze u `tests/db/`. Jedino je mjesto i pretvorbe imena stupaca iz `snake_case` u `camelCase` (docs/CODE_STYLE.md, pravilo 9). Cijela mapa ima floor `critical`.

- `with-actor.ts`: `createWithActor(pool)`. Svaki poziv je jedna transakcija `READ COMMITTED` u kojoj `app.session_token` (lokalno za transakciju) nosi token sesije; identitet nikad nije parametar. Prijava mora biti obični član `ductus_app` (zaključavanje konfiguracije, F-018), dopuštene su samo naredbe nad podacima, ugniježđeni poziv se odbija, a veza se prije povratka u bazen čisti s `DISCARD ALL`.
- `current-actor.ts`: `createActorReader(withActor)`, port `ActorReader` kojim `server/session` čita osobu, ustanovu i oznaku ustanove iz `app.current_actor()`. Retke pretvara u camelCase (`userId`, `institutionId`, `institutionSlug`), jedno čitanje je jedna naredba u jednoj transakciji; `actorReader` je primjerak nad aplikacijskim `withActor`.
- `open-session.ts`, `backchannel-logout.ts`: otvaranje sesije pri prijavi i zatvaranje sesija iz back-channel odjave, preko prijave u `ductus_auth`.
- `log-settings.ts`: prije prve transakcije provjerava da baza ne zapisuje parametre naredbi (token sesije je parametar).
- `plain-label-check.ts`: jednokratna provjera prije migracije `institution_plain_label_marks` (samo čita, imenuje redak, nikad pohranjeno ime): `DATABASE_URL=… node server/database/plain-label-check.ts`.
- `migration-lock.ts`: `connectLockClient(url, options)`, veza na kojoj [scripts/db/migrate-locked.ts](../../scripts/db/migrate-locked.ts) drži zaključavanje migracija (`pg_advisory_lock`, D-91 (3)); S-0.13.
- `registry.ts`: registar veza (S-1F-a, DAN-783), jedino mjesto koje stvara bazen. Zatvoren popis `POOLS`: `main` (`APP_DATABASE_URL`, 10 veza), `auth` (`AUTH_DATABASE_URL`, druga prijava na glavnu bazu, 2), `logs` (`LOGS_DATABASE_URL`, 4) i `legal` (`LEGAL_DATABASE_URL`, 2); nova baza je novi redak, nepoznato ime je greška. Svaka baza ima svoj bazen, granice i čekanja, pa pad, zastoj ili iscrpljen bazen jedne baze ne dira druge. `health()` za `main`, `logs` i `legal` paralelno i s rokom od 2 s vraća `ok`, `nedostupno` ili `nije_konfigurirano` (riječi `CapabilityStatus` iz ugovora; jednakost drži `server/http/databases.test.ts`). `close()` zatvara sve otvorene bazene i kad jedan padne, a poslije toga svaki `pool()` odbija. Greške i zapisi nose samo ime baze ili varijable i kod, nikad niz veze, korisnika ni lozinku. Granicu (bazen i klijent samo ovdje, uz `migration-lock.ts` i `plain-label-check.ts`) drži `registry-boundary.test.ts`.
- `index.ts`: javno sučelje: `withActor` (bazen `main`), `openSession` i `backchannelLogout` (bazen `auth`), `databaseHealth()` (ulaz za `ready`, S-1M-a), granice bazena (`APP_*`, `appPoolConfig`, `handleConnectionErrors`), `closePools()` koji pri gašenju zatvara otvorene bazene (poslije toga svaki pristup bazi odbija, S-1B-c) i tvornice nad bazenom ili okolinom pozivatelja za testove (`createRegistry` samo za `tests/db`).

Preneseno iz Ductusa `src/server/db/` (`d52a92c3`, S-0.13 i S-0.17, DAN-726 i DAN-730) bez promjene logike. Testovi uz kod: `registry.test.ts`, `registry.integration.test.ts` (zaustavljena i zamrznuta baza bez PostgreSQL-a), `registry-boundary.test.ts`, `with-actor.test.ts`, `log-settings.test.ts`, `plain-label-check.test.ts`, `current-actor.test.ts` i `session-guc-scope.test.ts` (nijedna postavka sesije ne nadživi transakciju); s bazom u `tests/db/` (`database-registry` (zaustavljena baza zapisa, iscrpljen bazen, zatvaranje), `with-actor`, `open-session`, `app-database`, `plain-label-check`). `job-queue.ts` (red poslova na pg-bossu) dolazi s workerom i `attempt-fence` (S-M-\*, VS-1b).

Mapa ne uvozi ništa iz drugih područja.

## Baze i veze

Tri baze, svaka sa svojim migracijama i pgTAP testovima u `db/<baza>/`. Web proces do njih dolazi samo kroz registar (`registry.ts`), jedan bazen po vezi; nizovi veza su u varijablama okoline i nikad u repou.

| Veza    | Baza           | Varijabla            | Veza je prijava u grupi               | Bazen | Za što                                                                               |
| ------- | -------------- | -------------------- | ------------------------------------- | ----- | ------------------------------------------------------------------------------------ |
| `main`  | `ductus`       | `APP_DATABASE_URL`   | `ductus_app`                          | 10    | sav rad web procesa, samo kroz `withActor`                                           |
| `auth`  | `ductus`       | `AUTH_DATABASE_URL`  | `ductus_auth`                         | 2     | otvaranje sesije i back-channel odjava (`openSession`, `backchannelLogout`)          |
| `logs`  | `ductus_logs`  | `LOGS_DATABASE_URL`  | jedna od grupa `ductus_logs_*` (niže) | 4     | zapisi; vlastiti klaster, pa pad ne dira `main`                                      |
| `legal` | `ductus_legal` | `LEGAL_DATABASE_URL` | `ductus_legal_app`                    | 2     | pravni tekstovi (tablice dolaze sa S-1N-a); isti klaster kao `main`, odvojen pravima |

## Uloge

Nijedna grupna uloga nema `LOGIN`; prijava je običan član jedne grupe i nema prava mimo nje (`db/main/tests/010-roles-and-privileges.sql`). Uloge prave lokalno `db/<baza>/local/*.sql`, u stagingu i produkciji B0.1; migracije ih samo provjeravaju.

- **`main`:** `ductus_migrator` (jedini s DDL-om), vlasnici tablica `ductus_identity`, `ductus_evidence` i `ductus_queue` (NOLOGIN), `ductus_app` (web proces: čita kroz RLS, piše samo kroz funkcije), `ductus_auth` (povratni poziv prijave), `ductus_worker` i `ductus_retention`.
- **`logs`:** `ductus_logs_migrator` (vlasnik baze), `ductus_logs_writer`, `ductus_logs_reader`, `ductus_logs_retention`.
- **`legal`:** `ductus_legal_migrator` (vlasnik baze), `ductus_legal_app`.

## `withActor`

`withActor(token, fn)` je jedini put do podataka glavne baze iz web procesa (opis gore, `with-actor.ts`). Identitet dolazi iz tokena sesije u `app.session_token`, a RLS i funkcije ga čitaju iz `app.current_actor()`; pristup nastaje iz odnosa, ne iz uloge (Ustav C-23).

## Migracije

- Svaka baza ima `db/<baza>/migrations/` (dbmate, `-- migrate:up` i `-- migrate:down`) i `db/<baza>/migrations.sum`. Pokreće ih `scripts/db/migrate-locked.ts --database <baza>` kao migrator te baze, pod zaključavanjem (`migration-lock.ts`): lokalno `pnpm db:migrate` (sve tri) ili `pnpm db:migrate:main|logs|legal`.
- Nova migracija mijenja i `migrations.sum` (`pnpm db:sum`). Migracije se iz agenta nikad ne primjenjuju na produkciju.

## Nova tablica

1. Migracija u `db/<baza>/migrations/` stvara tablicu u aplikacijskoj shemi (nikad u `public`) s vlasnikom NOLOGIN uloge te baze.
2. U istoj migraciji `ENABLE ROW LEVEL SECURITY` i `FORCE ROW LEVEL SECURITY` i barem jedna politika; politika koja propušta sve retke smije imenovati samo vlasnika, nikad PUBLIC.
3. Prava: web proces tablicu samo čita kroz RLS; pisanje u evidenciju, predaju i revizijski trag ide samo kroz funkciju (RPC).
4. **Redak u pgTAP matrici pristupa** (`db/<baza>/tests/`, u `main` po uzoru na `030-institution-access-matrix.sql`): tko čita, tko piše, i da tuđi redak nije vidljiv.
5. `pnpm db:sum`, zatim pgTAP te baze (niže). `000-rls-everywhere.sql` pada dok tablici nedostaje ENABLE, FORCE ili politika.

## pgTAP po bazi

`db/<baza>/tests/000-rls-everywhere.sql` (S-1F-b) iz kataloga (`pg_class`) traži ENABLE i FORCE RLS i barem jednu politiku na svakoj tablici te baze, u svim shemama. Izostavljene su samo tablice sustava koje je napravio `initdb` (po oidu ispod 16384, ne po imenu sheme, pa se vidi i tablica podmetnuta u `pg_catalog` ili `information_schema`) i privremene tablice. Jedina imenovana iznimka je dbmate dnevnik `public.schema_migrations`, i to samo dok je obična tablica vlasnika baze do koje ne vodi particija, nasljeđivanje, pogled ni pravilo, i dok na njemu nitko osim vlasnika i superkorisnika, ni PUBLIC, nema nijedno pravo (u PostgreSQL-u 17 i `MAINTAIN`). Datoteka sama napravi tablice koje krše pravilo (druga shema, `public`, bez FORCE, `UNLOGGED`, particija, strana tablica, bez politike) i provjeri da ih vidi. Funkcija ili operator na putanji pretrage koji bi zasjenio `pg_catalog` zaustavlja datoteku prije prvog testa, a provjere se rade s putanjom pretrage svedenom na `pg_catalog`.

Pokreće se kao superkorisnik nad migriranom bazom (pgTAP se stvara u transakciji koja se vraća):

- `main`: `pnpm test:db:native` ili `pnpm test:db:main` (cijela `db/main/tests`); u CI-ju korak „pgTAP glavne baze”.
- `logs`: `pg_prove -h <host> -p <port> -U <superkorisnik> -d ductus_logs db/logs/tests/*.sql`.
- `legal`: isto nad `ductus_legal` s `db/legal/tests/*.sql`.

pgTAP baza `logs` i `legal` još ne ide u CI; to dolazi sa S-1F-d (nadovezuje se na DAN-759).

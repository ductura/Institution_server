# Ductura / server

Zajednički API za sva Ductura sučelja: prijava AAI@EduHr, ovlasti, baza i pozadinski poslovi.

## Preduvjeti

- Node.js 24 (`.nvmrc`; `engines` u `package.json` traži barem 24).
- pnpm 10 (`packageManager` u `package.json`; najlakše preko `corepack enable`).

## Pokretanje

Server s prijavom preko simulatora AAI@EduHr, migracijama i izmišljenim ustanovama, jednom naredbom na Windowsu i Linuxu: `pnpm lokalno` ([docs/LOKALNO.md](docs/LOKALNO.md)).

```bash
pnpm install
pnpm build              # jedan ulaz server/server.ts -> jedna datoteka dist/server.js (esbuild)
pnpm start              # node --disallow-code-generation-from-strings dist/server.js (DAN-772); traži APP_DATABASE_URL, sluša na HOST:PORT (zadano 127.0.0.1:4000)
pnpm typecheck          # TypeScript strict, bez izlaznih datoteka
pnpm lint               # ESLint nad cijelim repoom, bez upozorenja
pnpm test               # unit, property i integration, jedan za drugim (bez baze)
pnpm test:unit
pnpm test:property
pnpm test:integration  # integracijski testovi; testne baze na PGliteu (test-support/database)
pnpm test:integration:pg # testovi ovlasti (*.pg.integration.test.ts) na pravom PostgreSQL-u; traže migrirane baze
pnpm test:equality      # test jednakosti (server/tests/equality)
pnpm test:database      # testovi migracija, zatim test:integration:pg; traže migrirane baze na 127.0.0.1:54329 i :54330 (posao database u CI-ju);
                        # klaster :54330 radi s wal_level=logical (compose postgres-logs; stari kontejner: docker compose up -d --force-recreate postgres-logs)
pnpm contracts:generate # ponovno generira server/contracts/generated i openapi/v1.json iz ugovora
pnpm contracts:breaking [ref] # ruši se kad ugovor lomi klijente openapi/v1.json na ref (zadano origin/main)
pnpm db:up              # lokalni PostgreSQL u Dockeru (compose.yaml) i sve migracije; db:up:native bez Dockera; db:seed učitava izmišljene podatke
pnpm db:sum             # ponovno računa db/main/migrations.sum (knjiga migracija; ručno se ne uređuje)
pnpm test:db:main       # pgTAP matrica glavne baze (db/main/tests); test:db:native podiže nativni stog i pokreće je
pnpm stog:gore          # cijeli lokalni stog (docs/lokalno/STOG.md); stog:dolje gasi, stog:zdravlje provjerava
pnpm dev:lazni-server   # lažni dev server iz @ductura/test-fakes (samo lokalni razvoj)
pnpm release:check      # provjera izdanja (release:stage, release:tag i release:tarball su dijelovi tog tijeka)
```

Pregled okoline za produkciju je u [docs/OPERATIONS.md](docs/OPERATIONS.md), postavljanje u [docs/DEPLOY.md](docs/DEPLOY.md) i [docs/STAGING.md](docs/STAGING.md). Kod je u TypeScriptu. Server se za pokretanje gradi u `dist/server.js` (`pnpm build`); skripte i testovi se pokreću izravno (Node 24, `tsx`), bez koraka prevođenja. Neispravna okolina zaustavlja pokretanje prije slušanja, s izlaznim kodom 78 (`EXIT_CONFIGURATION`) i retkom `startup.refused` koji imenuje varijablu, nikad vrijednost (`server/config`). Baza se pri pokretanju ne otvara: `server/database` se spaja pri prvom upitu, jedan pool po bazi (`main`, `logs`, `legal`), pa baza koja ne radi ruši samo vlastite pozive (prijava `APP_DATABASE_URL`).

### Lokalni računi

`pnpm lokalno` i `pnpm db:seed` učitavaju `db/main/local/seed.sql`: izmišljene osobe, kolegije i rad u ustanovi `demo-fakultet` (Ductus#2028, SRV-01). Prijava je na stranici simulatora (`http://localhost:8090`), gumbom računa. Svi podaci su izmišljeni; prijava je samo lokalna (D-09).

| Račun            | Uloga                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `demo-admin`     | administrator ustanove (imenovan kroz `appoint_institution_admin`)                       |
| `demo-teacher`   | nastavnik, nositelj triju kolegija; jednom otvorio rad `demo-student` (dnevnik pristupa) |
| `demo-teacher-2` | nastavnica, suradnica (vodi grupu B)                                                     |
| `demo-student`   | upisan u seminar, grupa A, obavijest potvrđena, rad otvoren                              |
| `demo-student-2` | nije upisan (prazni „Moji zadaci”)                                                       |
| `demo-student-3` | predaje rad o kućnom kompostiranju kroz `pnpm lokalno:predaje`                           |
| `demo-student-4` | predaje osvrt o gradskim vrtovima nakon roka kroz istu naredbu                           |
| `demo-bez-uloge` | djelatnik bez potvrđene uloge                                                            |

`demo-admin`, `demo-bez-uloge`, `demo-student-3` i `demo-student-4` su u `db/main/local/lazni-oidc-racuni.json` (`FAKE_OIDC_ACCOUNTS_FILE`). Vlastita `.local/oidc-racuni.json` tu datoteku zamjenjuje pa za pripremu predaja mora sadržavati oba nova računa. Kolegiji (2026./2027.) su „Izmišljeni seminar iz ekologije grada” (grupe A i B, `UPIS2026DEMO`), „Izmišljeni praktikum iz urbane sociologije” (bez zadatka, `PRAZNI2026DEMO`) i „Izmišljeni seminar iz urbane hidrologije” (zadatak „Kratki osvrt: gradski vrtovi” s isteklim rokom, `HIDRO2026DEMO`). Stari kod seminara `STARI2025KOD` je istekao i zamijenjen je.

Za SRV-17 pokreni `pnpm lokalno`, a u drugom terminalu `pnpm lokalno:predaje`. Ako je stog pokrenut s `--izravno`, dodaj istu zastavicu i naredbi za predaje. Skripta preko `/api/v1` upisuje dva nova računa, potvrđuje obavijesti, zapisuje izmišljeni tekst i provjerava potpisanu potvrdu iste revizije pri ponovnom zahtjevu. Za `demo-student-3` provjeri stanje `submitted` u `GET /api/v1/student/assignment-work`. `demo-student-2` i dalje ima prazan popis kolegija. Ponovi naredbu za predaje i provjeri da se koristi ista potvrda.

Za taj prolaz stog treba montirane studentske rute za upis, zadatke, obavijest i potvrdu obavijesti te lokalnu pohranu evidencije i registrirani razvojni ključ za potpisivanje. Povezivanje tih preduvjeta s `pnpm lokalno` još je otvoreno na koordinaciji SRV-17.

## Struktura

| Mapa                | Sadržaj                                                                                                                                                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/`           | Kod poslužitelja i testovi uz njega                                                                                                                                                                                     |
| `openapi/`          | Objavljeni OpenAPI dokument `v1.json`, generiran iz ugovora                                                                                                                                                             |
| `server/contracts/` | Ugovor API-ja `/api/v1` (TypeBox): izvor validacije, OpenAPI-ja, tipova, klijenta i lažnog servera                                                                                                                      |
| `locales/`          | Tekstovi sučelja i poruka na hrvatskom i engleskom (`hr.json`, `hr.ts`, `en.ts`), paritet i provjere kataloga                                                                                                           |
| `db/`               | Tri baze: `db/main` (glavna), `db/logs` (zapisi), `db/legal` (pravni tekstovi); svaka ima `migrations/`, `migrations.sum` i pgTAP `tests/`; dimni test okruženja `db/tests/`                                            |
| `packages/`         | `@ductura/contracts` (zajednički vektori i katalog grešaka) i `@ductura/test-fakes` (lažni OIDC, lažni server i dev server, sat, usluge, FIDO2); test-fakes je samo devDependency                                       |
| `test-support/`     | Ostala pomagala za testove (`test-idp/`, `fake-kms/`, `malformed-signatures/`)                                                                                                                                          |
| `config/`           | Konfiguracija po fakultetima (`config/faculties`)                                                                                                                                                                       |
| `infra/`            | Dockerfile slike lažnog OIDC-a, PostgreSQL-a i weba (lokalni stog i CI)                                                                                                                                                 |
| `docs/`             | Dokumentacija na hrvatskom (`plan/` je snimka kanonskog plana, `contracts/` ugovori, `adr/`); vidi [Pravilnik koda](docs/CODE_STYLE.md) i [Kartu servera](docs/server-map.md) (područja, dopušteni uvozi, tok zahtjeva) |
| `scripts/`          | Alati repoa (lokalna lint pravila, gate, CI u `scripts/ci/`, `db/`, `lokalno/`, `stack/`, `release/`, skener zabranjenih izraza)                                                                                        |
| `tests/`            | Testovi alata repoa (lint, formatiranje), ugovora (`tests/contracts`) i sloja baze (`tests/db`)                                                                                                                         |

Kanonski plan razvoja je u repozitoriju `ductura/.github` (`docs/plan/PLAN-MIGRACIJE.md`); ovdje je samo snimka [docs/plan/PLAN-MIGRACIJE.md](docs/plan/PLAN-MIGRACIJE.md) koja se ne uređuje. Pravila za agente su u [CLAUDE.md](CLAUDE.md) i [AGENTS.md](AGENTS.md).

## Lint

`eslint.config.ts` provjerava cijeli repo. Ignorira samo izlaze alata (`node_modules/`, `dist/`, `coverage/`).

- Imena datoteka su kebab-case. Dopušten je samo `.ts`, a testovi završavaju na `.test.ts`, `.property.test.ts` ili `.integration.test.ts`.
- Imena su `camelCase`, `PascalCase` ili `UPPER_SNAKE`.
- Zabranjeni su `any`, `interface` (umjesto njega `type`) i `enum`.
- U drugu mapu uvozi se samo kroz njezin `index.ts`.
- Upravljački program baze (`pg`, `pg-*`, `postgres`) uvozi samo `server/database` i testovi baze u `tests/db/` (`no-restricted-imports` i `database-boundary/no-restricted-dynamic-imports`, iz Ductusa; testovi u `tests/lint/pg-import-boundary*.test.ts`). `snake_case` imena stupaca i postavki baze dopuštena su samo u tim dvjema mapama.
- Direktive u retku (`eslint-disable`) ne gase nijedno pravilo. Sama direktiva ruši `pnpm lint`.

Lokalna pravila su u `scripts/lint-rules/`, a testovi nad fixtureima u `tests/lint/rules.test.ts`.

## Formatiranje

Prettier (`.prettierrc.json`) formatira cijeli repo osim izlaza alata i generiranog koda (`.prettierignore`).

- `pnpm format` formatira, `pnpm format:check` samo provjerava; CI pokreće `pnpm format:check` i pada na neformatiranu datoteku.
- `pnpm install` postavlja lefthook (`lefthook.yml`): prije commita formatira staged datoteke i ponovno ih stavlja u commit. Datoteke koje nisu staged ne dira.
- ESLint ne provjerava oblik koda: `eslint-config-prettier` je zadnji blok u `eslint.config.ts` i gasi svako pravilo koje bi se sukobilo s Prettierom.

Testovi su u `tests/format/format.test.ts`.

## Testovi

Vitest ima pet projekata. Projekt određuje sufiks datoteke, a `database` mapa `tests/db`. Testovi su samo u `server/`, `packages/`, `test-support/`, `scripts/`, `infra/`, `db/` i `locales/` (te `tests/`) sa sufiksom `.test.ts`; datoteka izvan toga ne pripada nijednom projektu i ne pokreće se. Projekt bez ijedne datoteke ruši pokretanje, zato `pnpm test` i CI pokreću projekte jedan po jedan.

| Projekt          | Datoteke                                                                                 | Što provjerava                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `unit`           | `{server,packages,test-support,tests,scripts,infra,db,locales}/**/*.test.ts`             | Pomoćne funkcije, memorijsku bazu, dimni test, lint pravila i formatiranje                                       |
| `property`       | `{server,packages,test-support,tests,scripts,infra,db,locales}/**/*.property.test.ts`    | Svojstva pravila pristupa (fast-check)                                                                           |
| `integration`    | `{server,packages,test-support,tests,scripts,infra,db,locales}/**/*.integration.test.ts` | HTTP poslužitelj od zahtjeva do odgovora                                                                         |
| `database`       | `tests/db/**/*.integration.test.ts` (izuzeti iz `integration`)                           | Migracije glavne baze, zaključavanje migracija i sloj baze (`withActor`, `openSession`) na pravom PostgreSQL-u   |
| `integration-pg` | `**/*.pg.integration.test.ts` (izuzeti iz `integration` i `database`)                    | Testovi ovlasti i paritet migracija PGlite/PostgreSQL ([test-support/database](test-support/database/README.md)) |

Pristup sadržaju proizlazi iz odnosa, ne iz uloge: svaka ruta ima test da tuđi sadržaj daje odbijanje, a pravila na razini baze provjerava pgTAP matrica (`db/main/tests`). Stari kostur `server/app.ts` još ima dimni test `server/app.integration.test.ts`.

Svi podaci u testovima su izmišljeni (`student-a@primjer.invalid`).

## CI

`.github/workflows/ci.yml` (okidači: PR i push u `main` i `migracija/kopija-ductus-backend`) ima tri posla uz zbirni `ci-ok`:

- `scope` razvrstava promjene (`scripts/ci/scope.ts`, pravila u [scripts/ci/README.md](scripts/ci/README.md)).
- `checks` („Provjere i testovi”) ima pet grana (`provjere`, `1/4` do `4/4`). Grana `provjere` pokreće statičke provjere (tipovi, knjiga migracija, lint, formatiranje, test jednakosti, probno izdanje, zaštita ugovora, slike), a četiri grane dijele vitest projekte unit i integration po datotekama (`vitest --shard`); svojstveni testovi rade na granama 3/4 i 4/4.
- `database` („PostgreSQL i pgTAP”) ima tri grane (`shard: [1, 2, 3]`). Podiže PostgreSQL 17 nativno iz PGDG repoa, bez Dockera, primjenjuje migracije kroz `scripts/db/migrate-locked.ts` i dijeli po datotekama projekte `database` i `integration-pg` te pgTAP matricu (`pnpm test:db:native`).
- `ci-ok` je jedini zbirni status. PR prema `main` u kojem su samo obični dokumenti (`docs/**/*.md`, `README.md`) preskače posao baze i prolazi `ci-ok`; pad bilo kojeg potrebnog posla ruši `ci-ok`. Push i PR prema drugoj grani (npr. `migracija/kopija-ductus-backend`) uvijek rade puni profil.

Akcije su prikvačene na puni SHA. Uz `ci.yml` postoje `engineering-gate.yml`, `release.yml`, `publish.yml`, `sbom.yml`, `verapdf.yml` i `docx-provenance-spike.yml`.

## Stanje servera

- Prijava: studenti i nastavnici se prijavljuju isključivo preko AAI@EduHr (D-09); tok i sesije su u `server/http/auth.ts` i `auth-flow.ts`, a `server/server.ts` ih montira kroz `createAuthRoutes`. Sesija je kolačić, a pristup sadržaju određuje baza iz odnosa (student u kolegiju, nastavnik zadatka, mentor rada). Zaglavlje `Authorization: Bearer <korisnik>` iz starog kostura `server/app.ts` nije način prijave i ne koristi se u pravom serveru.
- Lažni OIDC pružatelj (`packages/test-fakes/oidc/`, „Demo prijava”): samo lokalno i u CI-ju (D-09), računi su izmišljeni. Pokreće ga `pnpm lokalno` (port 8090) ili ručno `pnpm exec tsx packages/test-fakes/oidc/server.ts`. `FAKE_OIDC_MODE` bira način rada: `success` (zadano), `refuse`, `expired`, `unavailable`. S `NODE_ENV` različitim od praznog, `development` i `test` ne pokreće se.
- Baza: PostgreSQL 17, tri baze (`db/main`, `db/logs`, `db/legal`) s migracijama i RLS-om; web proces radi pod prijavom `ductus_app` kroz `withActor` (`server/database`). Memorijski `server/store.ts` ostao je samo za stari kostur.
- Pozadinski poslovi: prvi radnik (potpis potvrda na čekanju, `server/worker/signing`) postoji kao modul, a ulazna točka procesa radnika je još planirana ([server/worker/README.md](server/worker/README.md)).

## API

Ulaz `server/server.ts` montira rute ugovora `/api/v1` (health, ready, prijava, student, nastavnik, ustanova, evidencija, predaje, zapisi i druge). Ugovor ima 351 operaciju (`openapi/v1.json`). Samo četiri su ugovorene, a nemontirane (`CONTRACT_ONLY` u `server/contracts/inventory.ts`): `institution.enrollments.post`, `institution.role-confirmation.post`, `institution.role-revocation.post` i `ops.events.get`; `tests/contracts/contract-only.test.ts` čuva da popis odgovara montiranim rutama. Popis ruta s pojedinostima je u ugovoru (`server/contracts/routes/`) i u [server/http/README.md](server/http/README.md), a ranija zbirka u [docs/vs1-rute.md](docs/vs1-rute.md).

Stari kostur `server/app.ts` ima `GET /api/documents`, `GET` i `PUT /api/documents/:id`; ostaje samo kao dimni test i ne pokreće se kao server.

Unutarnje rute poslužitelj–poslužitelj (Aplication_server → Institution_server, ugovor Ductus#2028 c.6993786629 §2) montira `server/server.ts`: `POST /internal/v1/institutions` i `GET /internal/v1/institutions/{slug}` (`server/http/internal-institutions.ts`). Traže `Authorization: Bearer` jednak varijabli `DUCTURA_PROVISIONING_TOKEN` (najmanje 32 znaka, samo iz okoline); bez nje obje vraćaju 404. Nisu dio javnog ugovora `/api/v1`. Prijavljeni račun čita `GET /api/v1/me` (§3.3).

## Ugovor API-ja (`server/contracts/`)

Ugovor je izvor koda (DAN-736, Ductura U4). Svaka ruta ima shemu u `server/contracts/routes/`: ulaz (parametri putanje, upit, tijelo, vrsta i najveća veličina tijela), uspješne odgovore, greške (status, zatvoreni kod i ključ za locales `errors.<kod>`) i „tko smije” (`access`, zatvoren skup). „Tko smije” je deklaracija; ovlast i dalje odlučuje baza. `server/contracts` uvozi samo `@sinclair/typebox`.

`pnpm contracts:generate` iz ugovora piše u `server/contracts/generated/`: `validate.ts` (validatori ulaza), `types.ts`, `client.ts` (fetch klijent, radi i izvan preglednika) i `fake-server/` (lažni server, U8: zahtjev koji odgovara vektoru iz `server/contracts/vectors/` dobiva točno taj odgovor, a kad ih odgovara više, prvi po redu u datoteci ili onaj koji imenuje zaglavlje `x-ductura-fake-vector`; ruta bez odgovarajućeg vektora 501 `not_implemented`, kriva metoda 405, ostalo 404 `not_found`). Lažni server je samo za testove: `eslint.config.ts` zabranjuje njegov uvoz izvan testova, `server/test-server/` i `test-support/`, a `server/contracts/fake-server-production.test.ts` provjerava da ga ulazna točka ne doseže. Uz njih piše objavljeni OpenAPI 3.1 dokument `openapi/v1.json`. Generirane datoteke se commitaju; test pada kad se razlikuju od novog generiranja.

### Verzija i zaštita od lomljenja (DAN-737, Ductura U5)

`info.version` u `openapi/v1.json` je `glavna.manja.zakrpa` iz `server/contracts/version.ts`. Glavna verzija je ona iz `API_PREFIX` (`/api/v1`) i imena datoteke. Svaka promjena dokumenta traži višu verziju: nova ruta ili polje podiže manju, promjena teksta zakrpu.

Promjena koja lomi postojeće klijente nije dopuštena unutar iste glavne verzije. CI na svakom PR-u pokreće `pnpm contracts:breaking` prema ciljnoj grani. Zaštita je zatvorena prema zadanome (Ductus#87, c.6880838648): sheme se normaliziraju (sortirani ključevi, bez `description`, `example`, `examples` i `title`), a svaka preostala razlika postojeće rute, parametra, polja, statusa (i statusa greške), zaglavlja ili `x-*` ključa ruši CI, bez zaključivanja o tome sužava li ili proširuje (`anyOf`, `format`, ograničenja). Sigurne su samo: nova ruta ili metoda; novo neobavezno polje u odgovoru; novo neobavezno polje u zahtjevu kad je objekt i prije i poslije zatvoren (`additionalProperties: false`), jer ga nijedan stari zahtjev nije mogao poslati; promjena `description`, `example`, `examples` ili `title`. Nalaz je oblika `GET /api/v1/x <JSON pointer>: field removed`. Lomljiva promjena je nova glavna verzija, novi dokument i nova putanja.

Popis ruta je preslika inventara iz Ductusa (`server/contracts/inventory.ts`). Ruta izvan inventara ruši test. Svaka datoteka inventara ima shemu; popis `PENDING` je prazan i smije se samo smanjivati. Trenutačna verzija ugovora je 1.142.0 (`server/contracts/version.ts`).

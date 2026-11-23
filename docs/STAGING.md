# Staging: Render i Vercel

Staging Ducture diže se s migracijskih grana, ne s `main` (odluka vlasnika 23. 11. 2026., „b i a, postavi staging s migracijske grane”, Ductus#2055 c.7101552311):

| Dio                                    | Repo i grana                                                            | Gdje                                       |
| -------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| Server (`Institution_server`)          | `ductura/Institution_server`, `migracija/kopija-ductus-backend`         | Render, Blueprint `render.staging.yaml`    |
| Front (`Institution_front_web_chrome`) | `ductura/Institution_front_web_chrome`, `migracija/kopija-ductus-front` | Vercel, projekt s korijenom `packages/app` |

U repou su samo imena i koraci. Tajne (lozinke, `OIDC_CLIENT_SECRET`, `DUCTURA_PROVISIONING_TOKEN`) upisuješ samo u Render i Vercel, nikad u repo ni u komentar. **Ništa se ne objavljuje dok Daniel ne kaže**: stvaranje Blueprinta u koraku 1 već je prvi deploy.

Na stagingu su samo izmišljeni podaci (`demo-*`, `db/main/local/seed.sql`). Prava prijava studenata ide samo kroz AAI@EduHr (D-09). Lažna OIDC prijava na stagingu radi samo u izričitom staging načinu koji uvodi STG-PRIJAVA (`DUCTURA_DEPLOYMENT=staging` i `APP_ORIGIN` koji nije produkcijska domena); produkcija je i dalje odbija. Nijedna ustanova još nije pristala biti matična za testni AAI@EduHr resurs, pa staging dobiva lažnog pružatelja kao **zasebnu Render uslugu** `ductura-fake-oidc-staging` (odluka vlasnika 23. 11. 2026., „Idemo B”; STG-OIDC), nikad kao rutu servera (U9). Testni AAI@EduHr klijent (a) je usporedan put: kad stigne, mijenjaju se samo varijable `DUCTUS_AUTH_PROVIDER` i `OIDC_*` servera (odjeljak „Prelazak na AAI@EduHr (a)”).

Produkcija ostaje u `render.yaml` i [DEPLOY.md](DEPLOY.md); ovaj dokument je ne mijenja.

## Datoteke

- `render.staging.yaml`: web usluga `ductura-institution-server-staging` (frankfurt, grana `migracija/kopija-ductus-backend`, ista produkcijska faza `infra/web/Dockerfile`, bez `dockerTarget`, health check `GET /api/v1/health`, `autoDeployTrigger: "off"`) i dvije baze PostgreSQL 17: `ductura-institution-db-staging` (baza `ductus`) i `ductura-institution-logs-db-staging` (baza `ductus_logs`). Plan nije zadan, biraš ga u Renderu.
- `render.staging.yaml`, druga web usluga: `ductura-fake-oidc-staging` (lažni OIDC pružatelj, frankfurt, ista grana, slika `infra/fake-oidc/Dockerfile`, health check `GET /.well-known/openid-configuration`, `autoDeployTrigger: "off"`). Slika nosi samo izvorni kod pružatelja (`packages/test-fakes/oidc/`) i njegove ovisnosti iz lockfilea, bez `.env*` i bez ijedne tajne; `DUCTURA_DEPLOYMENT=staging` je u njoj fiksan, pa lokalni način u njoj ne radi.
- `infra/web/render-staging-blueprint.test.ts` (u `pnpm test`) drži `render.staging.yaml` usklađenim s kodom, s `render.yaml` i s ovim dokumentom (odjeljak „Provjera bez Rendera”).

`autoDeployTrigger: "off"` znači da push na granu ne objavljuje sam. Migracije pokrećeš ručno (korak 3), pa svaka objava ide redom: migracije, zatim **Manual Deploy** u Renderu.

## Što Daniel radi, redom

Potrebno na računalu: repo `Institution_server` na grani `migracija/kopija-ductus-backend`, `pnpm install` (daje `dbmate`), `psql` 15 ili noviji (zbog `\getenv`) i `perl`. Naredbe su za bash (Git Bash ili WSL na Windowsu) i pokreću se u korijenu repoa.

Koraci 3, 4 i 6 postoje i kao jedna skripta: `bash scripts/staging/baze.sh 3|4|6|sve`. Adrese baza i lozinke traži skriveno i smije se pokrenuti ponovno. Ako se skripta i ovaj dokument razlikuju, vrijedi dokument, a skripta se usklađuje u istom PR-u.

### 1. Render: Blueprint

1. **New → Blueprint**, repo `ductura/Institution_server`, grana `migracija/kopija-ductus-backend`, **Blueprint Path** `render.staging.yaml`.
2. Render stvori uslugu i obje baze i traži vrijednosti varijabli sa `sync: false`. Upiši ih po tablici u koraku 5; one koje još nemaš (prijave baza, adresa fronta) upiši kad ih dobiješ u koracima 2 do 4. Prazne ostaju `LEGAL_DATABASE_URL` i `EVIDENCE_STORAGE_DOMAINS`.
3. Prvi deploy pada (server bez ispravnog `APP_DATABASE_URL` izlazi s kodom 78) dok ne napraviš korake 3 i 4. To je očekivano.
4. Zapiši adresu usluge, npr. `https://ductura-institution-server-staging.onrender.com`, i za obje baze **External Database URL** (URL vlasnika baze). URL vlasnika služi samo za korake 3 i 4 s tvog računala; nikad ne ide u varijable usluge.

### 1b. Lažni OIDC pružatelj: usluga `ductura-fake-oidc-staging`

Blueprint iz koraka 1 stvara i ovu uslugu. Ona je pružatelj prijave dok vrijedi (b): stranica „Demo prijava” s oznakom „Samo testno okruženje”, samo izmišljeni računi `demo-*` (bez obrasca za račun bilo koje ustanove), i svaki odgovor nosi zaglavlje `X-Ductura-Deployment: staging`. Pokreće se samo uz ispravne vrijednosti; inače izlazi, a log imenuje varijablu (nikad vrijednost). Opis pravila: `packages/test-fakes/oidc/README.md`, odjeljak „Staging način”.

1. Zapiši adresu usluge, npr. `https://ductura-fake-oidc-staging.onrender.com`. To je `ISSUER` ove usluge i `OIDC_ISSUER` servera (korak 5), bez kose crte na kraju.
2. U **ductura-fake-oidc-staging → Environment** upiši:

| Ime                       | Vrijednost na stagingu                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`              | isto kao `APP_ORIGIN` servera (korak 2.5); samo https podrijetlo, nikad `ductura.org` ni njegove poddomene                             |
| `ISSUER`                  | adresa ove usluge iz 1b.1; samo https podrijetlo javnog hosta izvan `ductura.org` i poddomena, bez putanje, kose crte na kraju i porta |
| `FAKE_OIDC_CLIENT_SECRET` | nova vrijednost, najmanje 32 znaka (npr. `openssl rand -base64 32`); ista vrijednost ide u `OIDC_CLIENT_SECRET` servera                |
| `FAKE_OIDC_COOKIE_KEY`    | druga nova vrijednost, najmanje 32 znaka, različita od tajne klijenta; potpisuje kolačiće pružatelja i nikamo drugamo ne ide           |

`DUCTURA_DEPLOYMENT`, `NODE_ENV`, `PORT` i `FAKE_OIDC_ACCOUNTS_FILE` se ne upisuju: staging način je u slici, `PORT` postavlja Render, a datoteka računa je u stagingu zabranjena.

Povratne adrese su zadane i sve su na `APP_ORIGIN`: prijava `/api/v1/auth/callback`, nakon odjave `/app/web/` i odjava s pružatelja `/api/v1/auth/backchannel-logout` (Vercel ih prosljeđuje serveru). Odgovaraju `OIDC_REDIRECT_URI` i `OIDC_POST_LOGOUT_REDIRECT_URI` servera iz koraka 5. Adresu izvan `APP_ORIGIN` (i `REDIRECT_URI`, `POST_LOGOUT_REDIRECT_URI` ili `BACKCHANNEL_LOGOUT_URI` ako ih netko upiše) pružatelj odbija pri pokretanju. ID klijenta je stalan: `ductura-staging`.

3. Kad je `APP_ORIGIN` poznat (korak 2), **Manual Deploy** ove usluge. Provjera: `GET <ISSUER>/.well-known/openid-configuration` vraća 200, polje `issuer` jednako je `ISSUER`, a odgovor nosi `X-Ductura-Deployment: staging`.

### 2. Vercel: front

1. **Add New → Project**, uvezi `ductura/Institution_front_web_chrome`.
2. **Root Directory**: `packages/app`. Framework je Next.js (`packages/app/vercel.json` već zadaje naredbe instalacije i gradnje).
3. **Settings → Environments → Production → Branch Tracking**: grana `migracija/kopija-ductus-front`. Tako stalna adresa projekta (`https://<projekt>.vercel.app`) prati migracijsku granu.
4. Varijabla okoline (Production): `INSTITUTION_SERVER_URL` = adresa usluge iz koraka 1.4, bez kose crte na kraju. Čita se pri gradnji (`packages/app/src/rewrites.ts`), pa nakon promjene pokreni **Redeploy**.
5. Zapiši stalnu adresu projekta, npr. `https://ductura-staging.vercel.app`. Ona je `APP_ORIGIN` servera. Front je pod `/app/web/`, a `/api/v1/*` Vercel prosljeđuje serveru.

### 3. Glavna baza `ductus`: uloge i migracije

Vlasnik baze na Renderu nije superuser. Lokalno `db/main/local/migrator.sql` radi kao superuser, pa na Renderu ide jedan korak prije njega: vlasnik sam stvori `ductus_migrator` i pritom dobije SET i INHERIT nad njim. Bez toga `ALTER DATABASE ... OWNER TO ductus_migrator` pada („must be able to SET ROLE”), a nakon prve migracije vlasnik više ne bi mogao ni spojiti se na bazu jer migracije oduzimaju CONNECT svima osim vlasnika baze.

```sh
# URL vlasnika iz Rendera (External Database URL), samo u ovoj ljusci.
export STG_MAIN_OWNER_URL='postgres://...frankfurt-postgres.render.com/ductus?sslmode=require'

psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -c "SELECT rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = current_user"
# rolcreaterole mora biti t; bez toga stani i javi u Owner queue (B0.1).
# rolbypassrls zapiši: o njemu ovisi korak 6.

psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 \
  -c "SET createrole_self_grant = 'set, inherit'" \
  -c "CREATE ROLE ductus_migrator NOLOGIN NOSUPERUSER CREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS"
psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q -f db/main/local/migrator.sql
node scripts/db/migrate-locked.ts --url "$STG_MAIN_OWNER_URL&role=ductus_migrator"
```

`createrole_self_grant` vrijedi samo za tu jednu naredbu `CREATE ROLE`. Grupne uloge zatim stvara `migrator.sql` kao `ductus_migrator`, s istim članstvima kao lokalno. Svaka sljedeća objava ponavlja samo zadnji redak (migracije su idempotentne; runner drži zaključavanje, D-91).

### 4. Prijave procesa i baza zapisa

Lokalne datoteke prijava (`app-login.sql`, `auth-login.sql`, `worker-login.sql`) odbijaju TCP i nose lokalne lozinke, pa se na stagingu iste prijave rade ručno, s tvojim lozinkama (najmanje 16 znakova, generiraj ih npr. `openssl rand -base64 24`). Lozinke psql čita iz okoline (`\getenv`), pa ne ulaze u povijest naredbi ni u argumente procesa. Worker na stagingu ne postoji, pa ni njegova prijava. U Git Bashu `MSYS2_ENV_CONV_EXCL` sprječava da se lozinka koja počinje s `/` pretvori u Windows putanju prije psql-a.

```sh
export MSYS2_ENV_CONV_EXCL='STG_APP_PASSWORD;STG_AUTH_PASSWORD;STG_LOGS_PASSWORD'
read -rs STG_APP_PASSWORD && read -rs STG_AUTH_PASSWORD && export STG_APP_PASSWORD STG_AUTH_PASSWORD
psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
\getenv app_password STG_APP_PASSWORD
\getenv auth_password STG_AUTH_PASSWORD
SET ROLE ductus_migrator;
CREATE ROLE ductura_stg_app LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE ductura_stg_auth LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('ALTER ROLE ductura_stg_app PASSWORD %L', :'app_password') \gexec
SELECT format('ALTER ROLE ductura_stg_auth PASSWORD %L', :'auth_password') \gexec
GRANT ductus_app TO ductura_stg_app WITH INHERIT TRUE, SET FALSE;
GRANT ductus_auth TO ductura_stg_auth WITH INHERIT TRUE, SET FALSE;
RESET ROLE;
SQL
```

Baza zapisa (`ductus_logs`, druga instanca) ide isto: prvo `ductus_logs_migrator` s SET i INHERIT, zatim `db/logs/local/migrator.sql`, migracije i jedna prijava, član `ductus_logs_writer`.

```sh
export STG_LOGS_OWNER_URL='postgres://...frankfurt-postgres.render.com/ductus_logs?sslmode=require'
psql "$STG_LOGS_OWNER_URL" -v ON_ERROR_STOP=1 \
  -c "SET createrole_self_grant = 'set, inherit'" \
  -c "CREATE ROLE ductus_logs_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS"
psql "$STG_LOGS_OWNER_URL" -v ON_ERROR_STOP=1 -q -f db/logs/local/migrator.sql
node scripts/db/migrate-locked.ts --database logs --url "$STG_LOGS_OWNER_URL&role=ductus_logs_migrator"

export MSYS2_ENV_CONV_EXCL='STG_APP_PASSWORD;STG_AUTH_PASSWORD;STG_LOGS_PASSWORD'
read -rs STG_LOGS_PASSWORD && export STG_LOGS_PASSWORD
psql "$STG_LOGS_OWNER_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
\getenv logs_password STG_LOGS_PASSWORD
CREATE ROLE ductura_stg_logs LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
SELECT format('ALTER ROLE ductura_stg_logs PASSWORD %L', :'logs_password') \gexec
GRANT ductus_logs_writer TO ductura_stg_logs WITH INHERIT TRUE, SET FALSE;
SQL
```

Iz toga slažeš URL-ove za Render: korisnik i lozinka prijave, host je **Internal** host baze iz Rendera (promet ostaje u Renderovoj mreži), baza `ductus` ili `ductus_logs`, npr. `postgres://ductura_stg_app:<lozinka>@<interni-host>/ductus`. Zatim `unset STG_APP_PASSWORD STG_AUTH_PASSWORD STG_LOGS_PASSWORD`.

**Pravna baza `ductus_legal` na stagingu se ne stvara.** Na upravljanoj bazi bez superusera ne može se postaviti: `db/legal/local/migrator.sql` i migracija `db/legal/migrations/20261115130000_roles.sql` odbijaju svako članstvo u `ductus_legal_migrator` i svaki ADMIN nad pravnim ulogama, a vlasnik koji ih stvori dobiva ADMIN, i bez članstva ne može pokrenuti migracije kao `ductus_legal_migrator`. Provjereno probom (niže). Server danas pravnu bazu koristi samo u izvještaju stanja: `LEGAL_DATABASE_URL` ostaje prazan, `/api/v1/health` i `/api/v1/ready` odgovaraju 200. Otvoreno je pod „Otvoreno”.

### 5. Varijable usluge na Renderu

Upisuješ ih u **ductura-institution-server-staging → Environment**, ovim redom: prvo prijave baza (korak 4), zatim adresa fronta (korak 2), zatim prijava.

| Ime                             | Vrijednost na stagingu                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DUCTURA_DEPLOYMENT`            | `staging`; bez nje produkcijska gradnja odbija lažni pružatelj (STG-PRIJAVA)                                                                                              |
| `APP_ORIGIN`                    | stalna adresa Vercel projekta iz koraka 2.5, samo podrijetlo, npr. `https://ductura-staging.vercel.app`; nikad `ductura.org` ni `www.ductura.org`                         |
| `APP_DATABASE_URL`              | prijava `ductura_stg_app` u `ductus` (interni host)                                                                                                                       |
| `AUTH_DATABASE_URL`             | prijava `ductura_stg_auth` u `ductus` (interni host)                                                                                                                      |
| `LOGS_DATABASE_URL`             | prijava `ductura_stg_logs` u `ductus_logs` (interni host)                                                                                                                 |
| `LEGAL_DATABASE_URL`            | prazno (pravna baza se na stagingu ne stvara)                                                                                                                             |
| `TRUSTED_PROXIES`               | `10.0.0.0/8`, privatna mreža Renderova proxyja ispred usluge                                                                                                              |
| `DUCTUS_AUTH_PROVIDER`          | `fake-oidc` dok vrijedi (b); `aai-eduhr` kad Srce izda testni klijent (STG-AAI)                                                                                           |
| `OIDC_ISSUER`                   | (b): adresa usluge `ductura-fake-oidc-staging` (njezin `ISSUER`, korak 1b), npr. `https://ductura-fake-oidc-staging.onrender.com`; (a): issuer testnog AAI@EduHr klijenta |
| `OIDC_CLIENT_ID`                | (b): `ductura-staging`; (a): ID klijenta kod Srca                                                                                                                         |
| `OIDC_CLIENT_SECRET`            | (b): ista vrijednost kao `FAKE_OIDC_CLIENT_SECRET` (korak 1b); (a): tajna klijenta kod Srca                                                                               |
| `OIDC_REDIRECT_URI`             | `APP_ORIGIN` + `/api/v1/auth/callback`, npr. `https://ductura-staging.vercel.app/api/v1/auth/callback`                                                                    |
| `OIDC_POST_LOGOUT_REDIRECT_URI` | `APP_ORIGIN` + `/app/web/`; isto podrijetlo kao `OIDC_REDIRECT_URI`, a `/` na Vercelu nema stranicu                                                                       |
| `DUCTURA_PROVISIONING_TOKEN`    | nova vrijednost samo za staging, najmanje 32 znaka; nikad produkcijska                                                                                                    |
| `EVIDENCE_STORAGE_DOMAINS`      | prazno: dobavljač pohrane nije izabran (D-08), pa commit rada odgovara 503 `storage`                                                                                      |

`NODE_ENV`, `DUCTURA_MODE`, `DUCTUS_DEV_SIGNING_KEY_FILE`, `HOST` i `PORT` se ne upisuju: neodređen `NODE_ENV` je produkcija, a `PORT` postavlja Render.

O vrijednostima:

- **`APP_ORIGIN`**: provjera podrijetla uspoređuje zaglavlje `Origin` preglednika s njim. Preglednik vidi samo Vercel adresu (API ide kroz prosljeđivanje), pa je to adresa fronta, ne adresa Render usluge. Adresa pregleda (`*-git-*.vercel.app`) nije `APP_ORIGIN`: prijava radi samo na stalnoj adresi.
- **`TRUSTED_PROXIES`**: ispred procesa je Renderov proxy na privatnoj adresi, a ispred njega Vercel, čije adrese nisu stalne i ne smiju se navesti. Server zato kao adresu klijenta vidi izlaznu adresu Vercela; ograničenja po adresi na stagingu su grublja nego u produkciji. Raspon se ne smije proširiti preko `/8` (server ga odbija).
- **`EVIDENCE_STORAGE_DOMAINS`**: kad se izabere pohrana, vrijednost je JSON `{"requestTimeoutMs": ..., "domains": [{"label", "institutionId", "endpoint" (https), "region", "bucket", "accessKeyIdVar", "secretAccessKeyVar", "capability"}]}`, a ključeve dodaješ kao `EVIDENCE_S3_*` ([DEPLOY.md](DEPLOY.md)). Do tada je prazna.

### Prelazak na AAI@EduHr (a)

Kad Srce izda testni klijent (STG-AAI), na **ductura-institution-server-staging → Environment** mijenjaju se samo `DUCTUS_AUTH_PROVIDER` = `aai-eduhr` i varijable `OIDC_*` (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, te `OIDC_REDIRECT_URI` i `OIDC_POST_LOGOUT_REDIRECT_URI` ako Srce registrira druge adrese na istom `APP_ORIGIN`), zatim **Manual Deploy**. Kod, slika i ostale varijable se ne mijenjaju. Uslugu `ductura-fake-oidc-staging` tada u Renderu zaustaviš (**Suspend**); `DUCTURA_DEPLOYMENT` servera ostaje `staging`.

Seed (korak 6) veže demo ustanove uz issuer lažnog pružatelja (`identity.institution_issuer`), a korisnici koji su se prijavili lažnim pružateljem nose taj issuer. Ti redci ostaju u bazi i nakon prelaska: prije ili uz prelazak ukloni ih ili zamijeni retcima testnog AAI@EduHr issuera (zaseban zadatak trake S-B, ne ručni SQL na produkciji). Dok postoje, usluga `ductura-fake-oidc-staging` ostaje **suspendirana, ne obrisana**, da njezina javna adresa (`*.onrender.com`) ne pripadne nekom drugom dok je baza stagea još vezana uz nju.

### 6. Izmišljeni podaci (seed)

Seed su samo izmišljene ustanove, osobe, kolegiji i tekstovi iz `db/main/local/seed.sql` (računi `demo-*` lažnog pružatelja). Ide samo u staging, nikad u produkciju, i samo dok je prijava (b) lažna: pruža issuer lažnog pružatelja.

`seed.sql` lokalno radi kao superuser. Na stagingu vlasnik baze za trajanje seeda dobiva SET nad četiri vlasničke i aplikacijske uloge i radi sa zadanom ulogom `ductus_identity`; nakon seeda ih vraća. Prvog administratora ustanove (`institution.appoint_institution_admin`) smije upisati samo uloga koju politika revizijskog traga ne veže (prisilni RLS na `audit.teacher_role_event`), dakle samo uloga s `BYPASSRLS`.

**Ako je u koraku 3 `rolbypassrls` = `t`**:

```sh
export STG_OIDC_ISSUER='https://...'   # isti issuer kao OIDC_ISSUER u koraku 5
psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 \
  -c "GRANT ductus_identity, ductus_evidence TO CURRENT_USER WITH INHERIT TRUE, SET TRUE" \
  -c "GRANT ductus_auth, ductus_app TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"
sed -e '/^\\set ON_ERROR_STOP on$/,/^\\endif$/d' db/main/local/seed.sql \
  | perl -0pe 's{\x27http://localhost:8090\x27}{\x27$ENV{STG_OIDC_ISSUER}\x27}g == 2 or die "issuer not found twice\n"' \
  | psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q
psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 \
  -c "REVOKE ductus_identity, ductus_evidence, ductus_auth, ductus_app FROM CURRENT_USER"
```

`sed` skida psql zaštitu „samo lokalni socket”, a `perl` zamjenjuje lokalni issuer (`http://localhost:8090`, dva mjesta) issuerom stagea i staje ako ga ne nađe točno dva puta. Drugo pokretanje ne dodaje ništa. `REVOKE` pokreni i kad seed padne.

**Ako je `rolbypassrls` = `f`** (vjerojatno na Renderu): administrator se ne može upisati, a cijeli demo blok seeda je jedna transakcija, pa pada zajedno s njim. Tada idu samo ustanove i issuer (prvi dio seeda), a za evidencijsku domenu uloga se mijenja jer `ductus_evidence` ne čita `identity`:

```sh
export STG_OIDC_ISSUER='https://...'
psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 \
  -c "GRANT ductus_identity, ductus_evidence TO CURRENT_USER WITH INHERIT FALSE, SET TRUE"
sed -e '/^\\set ON_ERROR_STOP on$/,/^\\endif$/d' -e '/^DO \$demo\$$/,$d' db/main/local/seed.sql \
  | perl -0pe '
      s{INSERT INTO evidence\.domain .*?;\n}{SELECT id AS stg_institution FROM identity.institution WHERE slug = \x27demo-fakultet\x27 \\gset\nSET ROLE ductus_evidence;\nINSERT INTO evidence.domain (institution_id, region)\nSELECT :\x27stg_institution\x27, \x27local\x27\n WHERE NOT EXISTS (SELECT 1 FROM evidence.domain WHERE institution_id = :\x27stg_institution\x27);\nRESET ROLE;\n}s or die "evidence.domain not found\n";
      s{\x27http://localhost:8090\x27}{\x27$ENV{STG_OIDC_ISSUER}\x27}g == 1 or die "issuer not found\n";' \
  | PGOPTIONS='-c role=ductus_identity' psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -q
psql "$STG_MAIN_OWNER_URL" -v ON_ERROR_STOP=1 -c "REVOKE ductus_identity, ductus_evidence FROM CURRENT_USER"
```

Prijava tada radi za sve `demo-*` račune lažnog pružatelja (korisnik nastaje pri prvoj prijavi), ali nema administratora, potvrđenih nastavnika, kolegija ni zadataka. To je otvoreno pod „Otvoreno”.

**Administrator ustanove na stagingu se ne može prijaviti ni nakon uspješnog seeda.** U seedu je administrator `demo-fakultet` račun simulatora `sim:nastavnik:demo-admin@demo.ductus.test`, a staging pružatelj prima samo `demo-*` račune (STG-OIDC). Vidi „Otvoreno”.

### 7. Provjera

1. U Renderu **Manual Deploy** zadnjeg commita grane. Log ne smije sadržavati `.env*` u kontekstu gradnje ([DEPLOY.md](DEPLOY.md)).
2. `GET <adresa usluge>/api/v1/health` i `GET <APP_ORIGIN>/api/v1/health` vraćaju 200.
3. `<APP_ORIGIN>/app/web/` otvara prijavu; u staging načinu svaki odgovor nosi oznaku stagea (STG-PRIJAVA), a stranica „Demo prijava” na adresi `ductura-fake-oidc-staging` zaglavlje `X-Ductura-Deployment: staging`.
4. Prijava kao `demo-student` vodi natrag na `/app/web/`, odjava na `/app/web/`.

## Otvoreno

- **Pravna baza na upravljanoj bazi** (B0.1): `ductus_legal` se bez superusera ne može postaviti s današnjim `db/legal/local/migrator.sql` i prvom pravnom migracijom. Treba odluka kako se pravna baza provizionira na Renderu (zaseban zadatak trake S-B; migracija koja je već na bazi se ne mijenja, D-91).
- **Prvi administrator ustanove bez superusera** (B0.1): `appoint_institution_admin` radi samo za ulogu s `BYPASSRLS`. Treba provjeriti `rolbypassrls` vlasnika na Renderu; ako je `f`, demo na stagingu treba vlasnikovu odluku o načinu postavljanja prvog administratora.
- **Administrator ustanove na stagingu** (STG-OIDC): subjekt administratora u seedu je `sim:nastavnik:demo-admin@demo.ductus.test`, a staging pružatelj namjerno odbija `sim:*` račune, pa se na stagingu nitko ne prijavljuje kao administrator ustanove. Rješenje je zaseban zadatak: `demo-*` administratorski račun (npr. `demo-admin`) u `packages/test-fakes/oidc/accounts.ts` i usklađen subjekt u seedu. Obrazac `sim:*` se u stagingu ne otvara.
- **Slika lažnog pružatelja se ne gradi u CI-ju**: `infra/fake-oidc/Dockerfile` provjeren je samo statički (`dockerfile.test.ts`) i ručnim ponavljanjem koraka; prvi stvarni `docker build` je na Renderu. Prije prvog deploya preporučen je ručni `docker build -f infra/fake-oidc/Dockerfile .`, a poslije zaseban CI korak gradnje bez objave slike.
- **Lažni pružatelj na stagingu** (STG-OIDC): stanje (sesije, kodovi) drži u memoriji, a ključ potpisa stvara pri pokretanju. Svako ponovno pokretanje ili uspavljivanje usluge prekida otvorene prijave kod pružatelja; sesija u Ducturi ostaje, a nova prijava radi odmah. Na besplatnom planu Render uspavljuje uslugu nakon neaktivnosti, pa prva prijava nakon toga čeka buđenje.
- **Potpis i pohrana dokaza rada**: bez KMS potpisnika (D-71) i pohrane (D-08) `POST /api/v1/evidence/commit` na stagingu odgovara 503, pa studentsko pisanje ne sprema dokaze ([DEPLOY.md](DEPLOY.md)).
- **`TRUSTED_PROXIES`**: raspon `10.0.0.0/8` za Renderov proxy treba potvrditi na prvom deployu.

## Provjera bez Rendera

- `infra/web/render-staging-blueprint.test.ts` provjerava: jednu Docker uslugu produkcijske faze s granom `migracija/kopija-ductus-backend`, bez `dockerTarget` i bez automatske objave; da svaka varijabla nosi samo ime (`sync: false`); da su navedene sve varijable `render.yaml` i staging varijabla; da nijedna nije prekidač lokalnog rada ili testova; da su baze u regiji usluge, na glavnoj verziji PostgreSQL-a iz CI-ja, a imena različita od produkcijskih; da produkcijski `render.yaml` ne navodi staging varijablu; da je svaka varijabla opisana u ovom dokumentu; i da je lažni OIDC pružatelj zasebna usluga `ductura-fake-oidc-staging` iz `infra/fake-oidc/Dockerfile` na istoj grani i u istoj regiji, s četiri varijable bez vrijednosti, kojoj produkcijski `render.yaml` ne zna ime.
- `infra/fake-oidc/dockerfile.test.ts` provjerava sliku pružatelja: osnovna slika kao `infra/web/Dockerfile` (digest), fiksan `DUCTURA_DEPLOYMENT=staging`, bez tajni, bez `NODE_ENV` i `.env*`, ovisnosti samo iz lockfilea, korisnik `node`. Pravila staging načina provjeravaju `packages/test-fakes/oidc/staging.test.ts` i `staging.integration.test.ts`.
- Proba koraka 3, 4 i 6 (23. 11. 2026., PostgreSQL 16, dva klastera, vlasnik `LOGIN CREATEROLE CREATEDB` bez superusera, kao na Renderu): uloge i sve migracije glavne baze i baze zapisa prolaze, i drugo pokretanje migracija; prijave se spajaju; `db/legal/local/migrator.sql` pada na članstvu u `ductus_legal_migrator`; seed prolazi dva puta samo uz `BYPASSRLS`, a bez njega prvi dio prolazi i demo blok pada na `teacher_role_event`; `pnpm build` i `node dist/server.js` s tim prijavama i praznim `LEGAL_DATABASE_URL` i `EVIDENCE_STORAGE_DOMAINS` odgovaraju 200 na `/api/v1/health` i `/api/v1/ready`.

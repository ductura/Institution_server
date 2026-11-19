# Objava: Render

Institution_server ide na **Render** kao Docker web usluga. Slika je postojeći `infra/web/Dockerfile` (završna, produkcijska faza), bez izmjena. `render.yaml` ga samo koristi. Na Vercelu nije: proces stalno drži veze na tri baze i pozadinske poslove.

## Datoteke

- `render.yaml`: Blueprint s web uslugom `ductura-institution-server` (regija frankfurt, `dockerfilePath: ./infra/web/Dockerfile`, kontekst korijen repoa, health check `GET /api/v1/health`) i dvije baze PostgreSQL 17: `ductura-institution-db` (baza `ductus`) i `ductura-institution-logs-db` (baza `ductus_logs`). Plan nije zadan, pa ga biraš u Renderu.
- `infra/web/Dockerfile` (postojeći, [README](../infra/web/README.md)): korisnik `node`, `HOST=0.0.0.0`, `PORT` zadano 4000. Render postavlja svoj `PORT` pri pokretanju, a server ga slijedi. `HEALTHCHECK` je na `/api/v1/health`. U slici nema tajni ni `NODE_ENV`, a neodređen znači produkcija.
- `infra/web/Dockerfile.dockerignore`: Render gradi s BuildKitom, koji čita `.dockerignore` uz Dockerfile. Provjeri u prvom logu gradnje da `.env*` ne ulazi u kontekst.
- `infra/postgres/Dockerfile` je samo za lokalni rad i CI (pgTAP), ne ide na Render.

## Varijable okoline

Sve su `sync: false`: vrijednosti upisuješ ručno u Renderu, nikad u repo.

| Ime                                                   | Vrijednost                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_ORIGIN`                                          | javno podrijetlo koje vidi preglednik, npr. `https://ductura.org`; provjera podrijetla uspoređuje zaglavlje `Origin` s njim, ne `Host` |
| `APP_DATABASE_URL`                                    | prijava uloge web procesa u bazu `ductus`                                                                                              |
| `AUTH_DATABASE_URL`                                   | prijava uloge za prijavu (auth) u bazu `ductus`                                                                                        |
| `LOGS_DATABASE_URL`                                   | prijava u `ductus_logs`                                                                                                                |
| `LEGAL_DATABASE_URL`                                  | prijava u `ductus_legal`                                                                                                               |
| `TRUSTED_PROXIES`                                     | adrese i CIDR rasponi proxyja ispred servera; bez toga se `X-Forwarded-For` ne čita                                                    |
| `DUCTUS_AUTH_PROVIDER`                                | `aai-eduhr`; produkcija odbija lažni pružatelj (D-09)                                                                                  |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | podaci registracije kod Srca (AAI@EduHr)                                                                                               |
| `OIDC_REDIRECT_URI`                                   | `https://ductura.org/api/v1/auth/callback`                                                                                             |
| `OIDC_POST_LOGOUT_REDIRECT_URI`                       | `https://ductura.org/`                                                                                                                 |
| `DUCTURA_PROVISIONING_TOKEN`                          | ista vrijednost kao na Aplication_serveru, najmanje 32 znaka                                                                           |
| `EVIDENCE_STORAGE_DOMAINS`                            | JSON domena pohrane; on imenuje varijable `EVIDENCE_S3_*` koje onda dodaješ ručno                                                      |

`*_DATABASE_URL` nisu povezani s `fromDatabase`. Render za bazu daje URL vlasnika, a server traži zasebne uloge s ograničenim pravima (`db/main/local`, `db/logs/local`, `db/legal/local`). Pri pokretanju je obvezan samo `APP_DATABASE_URL`. Bez ostalih se proces diže, ali bez njih ne radi prijava (`AUTH_DATABASE_URL`) ni zapisi.

Pravila koja server provjerava (`server/config`, `server/external/srce-auth/config.ts`):

- `APP_ORIGIN` mora biti samo podrijetlo (`https://host`), bez putanje. Inače server ne kreće.
- U produkciji (`NODE_ENV` nije postavljen) `OIDC_ISSUER`, `OIDC_REDIRECT_URI` i `OIDC_POST_LOGOUT_REDIRECT_URI` moraju biti https URL-ovi javnog hosta. `OIDC_POST_LOGOUT_REDIRECT_URI` mora imati isto podrijetlo kao `OIDC_REDIRECT_URI`, a bez njega je `/` tog podrijetla. `OIDC_ISSUER` je sam issuer, ne adresa `/.well-known/`. Kriva vrijednost ne zaustavlja proces, nego prijava odgovara 503.
- `DUCTUS_AUTH_PROVIDER=fake-oidc` u produkciji se odbija (D-09).

Neobavezne varijable (ne treba ih upisivati):

| Ime                             | Zadano     | Značenje                                                                                      |
| ------------------------------- | ---------- | --------------------------------------------------------------------------------------------- |
| `OIDC_ID_TOKEN_ALG`             | `RS256`    | algoritam potpisa ID tokena (samo asimetrični)                                                |
| `OIDC_CLOCK_TOLERANCE_SECONDS`  | `30`       | dopušteni pomak sata, 0 do 120                                                                |
| `SHUTDOWN_GRACE_MS`             | `8000`     | rok urednog gašenja, 100 do 30000 ([server/config](../server/config/README.md))               |
| `METRICS_INTERVAL_MS`           | `60000`    | razmak uzorkovanja metrike, 5000 do 3600000 ([server/settings](../server/settings/README.md)) |
| `DUCTUS_EVIDENCE_ASYNC_SIGNING` | isključeno | samo `1` uključuje protokol 2 (potpisuje worker); worker ovdje još ne postoji                 |

**Potpis dokaza rada u produkciji još ne radi.** Razvojni potpisnik radi samo uz `NODE_ENV` `development` ili `test`. Inače je potpisnik odbijajući, pa `POST /api/v1/evidence/commit` odgovara 503 `signing` i ništa ne sprema (`server/http/evidence-deps.ts`). Potpisni ključ ustanove u KMS-u (D-71) treba priključiti prije prve objave u kojoj studenti pišu. Isto vrijedi za pohranu: bez `EVIDENCE_STORAGE_DOMAINS` commit daje 503 `storage`.

## Što Daniel radi ručno

1. U Renderu: **New → Blueprint**, repo `ductura/Institution_server`, grana `main`. Render stvori uslugu i obje baze i pita za varijable sa `sync: false`.
2. U instanci `ductura-institution-db` stvaraš bazu `ductus_legal`. Zatim, s računala s repoom i vanjskim URL-om baze, pokrećeš skripte uloga i migracija kao lokalno (`db/*/local/migrator.sql`, `scripts/db/migrate-locked.ts`). `pnpm db:migrate` koristi `docker compose`, pa na Renderu ne radi izravno. Slika ima samo `dist/server.js` i ne može migrirati. Prijave procesa (`app-login.sql`, `auth-login.sql`, `worker-login.sql`) odbijaju TCP i nose lokalne lozinke. Na Renderu zato iste uloge stvaraš ručno, s vlastitim lozinkama, koje ne idu u repo.
3. Prijava radi tek s pravom registracijom kod Srca. Slika testnog servera (`--target test-server`, lažni OIDC) nikad ne ide na Render ni na javni URL (D-09).
4. Adresu usluge upisuješ u `INSTITUTION_SERVER_URL` Aplication_servera i umjesto rezerviranog hosta u `vercel.json` Preloadera i fronta institucije.

## Gradnja lokalno

```sh
docker build -f infra/web/Dockerfile -t institution-server .
```

Postavljanje usluga i baza, registry i deploy nisu dio ovog PR-a.

## Provjera bez Rendera

- `infra/web/render-blueprint.test.ts` (u `pnpm test`) drži `render.yaml` usklađenim s kodom. Provjerava:
  - jednu Docker uslugu produkcijske faze s health checkom na postojećoj ruti;
  - da svaka varijabla nosi samo ime (`sync: false`, bez vrijednosti);
  - da su navedene sve četiri baze iz `server/database/registry.ts`, sve varijable koje prijava traži i `APP_ORIGIN`;
  - da nijedna varijabla nije prekidač lokalnog rada ili testova (`NODE_ENV`, `DUCTURA_MODE`, `DUCTUS_DEV_SIGNING_KEY_FILE`);
  - da su baze u regiji usluge, na glavnoj verziji PostgreSQL-a iz CI-ja;
  - da je svaka varijabla opisana u ovom dokumentu.
- Pokretanje kao na Renderu, bez Dockera: `pnpm build`, zatim `node --disallow-code-generation-from-strings dist/server.js` s varijablama iz tablice (lokalne prijave baze i izmišljene vrijednosti, bez `NODE_ENV`). Proces se diže i `GET /api/v1/health` vraća 200. Prijava odgovara 503 dok `OIDC_*` ne vode na pravog pružatelja.

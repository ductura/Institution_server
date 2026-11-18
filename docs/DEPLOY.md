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

`*_DATABASE_URL` nisu povezani s `fromDatabase`. Render za bazu daje URL vlasnika, a server traži zasebne uloge s ograničenim pravima (`db/main/local`, `db/logs/local`, `db/legal/local`). Neobavezne varijable (`SHUTDOWN_GRACE_MS`, `METRICS_INTERVAL_MS`) su u [server/config](../server/config/README.md). Potpisni ključ (KMS) i ostatak evidencije provjeri u `server/external/keys` i `server/external/storage` prije prve objave. Ovaj popis za njih nije konačan.

## Što Daniel radi ručno

1. U Renderu: **New → Blueprint**, repo `ductura/Institution_server`, grana `main`. Render stvori uslugu i obje baze i pita za varijable sa `sync: false`.
2. U instanci `ductura-institution-db` stvaraš bazu `ductus_legal`. Zatim, s računala s repoom i vanjskim URL-om baze, pokrećeš skripte uloga i migracija kao lokalno (`db/*/local/*.sql`, `scripts/db/migrate-locked.ts`). `pnpm db:migrate` koristi `docker compose`, pa na Renderu ne radi izravno. Slika ima samo `dist/server.js` i ne može migrirati.
3. Prijava radi tek s pravom registracijom kod Srca. Slika testnog servera (`--target test-server`, lažni OIDC) nikad ne ide na Render ni na javni URL (D-09).
4. Adresu usluge upisuješ u `INSTITUTION_SERVER_URL` Aplication_servera i umjesto rezerviranog hosta u `vercel.json` Preloadera i fronta institucije.

## Gradnja lokalno

```sh
docker build -f infra/web/Dockerfile -t institution-server .
```

Postavljanje usluga i baza, registry i deploy nisu dio ovog PR-a.

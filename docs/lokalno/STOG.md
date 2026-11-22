# Lokalni stog jednom naredbom (`pnpm stog:gore`)

Cijela aplikacija na jednom računalu: PostgreSQL s migracijama i seedom, Institution_server, lokalno spremište dokaza (S3) s razvojnim ključem za potpis, lažni OIDC (simulator AAI@EduHr) i Next.js front `Institution_front_web_chrome` iz susjedne mape. **Samo lokalni razvoj (D-09):** simulator i server ga odbijaju izvan `NODE_ENV` `development` i `test`. Svi računi i podaci su izmišljeni. Pojedinosti servera i simulatora su u [docs/LOKALNO.md](../LOKALNO.md).

## Preduvjeti

- Node.js 24, pnpm 10, Docker (za PostgreSQL).
- Front kloniran pored ovog repoa i instaliran: `../Institution_front_web_chrome`, u njemu `pnpm install`.
- U ovom repou `pnpm install`.

## Naredbe

| Naredba              | Što radi                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------- |
| `pnpm stog:gore`     | Podiže sve, redom: PostgreSQL → migracije i seed → simulator (`:8090`) → server (`:4000`) → front (`:3000`) |
| `pnpm stog:zdravlje` | Pita svaki servis; izlaz 0 samo ako svi odgovaraju                                                          |
| `pnpm stog:dolje`    | Gasi front, server i simulator te zaustavlja PostgreSQL (podaci ostaju u Docker volumenu)                   |

Nakon `stog:gore` otvori `http://localhost:3000`; prijava je `http://localhost:3000/api/v1/auth/login?returnTo=/`, računi simulatora su iz seeda (`db/main/local/lazni-oidc-racuni.json`, README „Lokalni računi”). Ctrl+C u terminalu gasi front, server i simulator (PostgreSQL ostaje; `pnpm stog:dolje` ga zaustavlja).

## Kako su servisi spojeni

Preglednik govori samo s frontom (`http://localhost:3000`). Front sve `/api/v1/*` prosljeđuje serveru (`INSTITUTION_SERVER_URL=http://127.0.0.1:4000`), pa kolačić sesije i povratna adresa prijave (`http://localhost:3000/api/v1/auth/callback`) pripadaju istom podrijetlu. Zato `stog:gore` pokreće `pnpm lokalno --izvor=http://localhost:3000`: `APP_ORIGIN` i povratna adresa servera i simulatora su podrijetlo fronta, a ne edge proxy na `:8000`.

| Servis                        | Adresa                                |
| ----------------------------- | ------------------------------------- |
| Front (Next.js)               | `http://localhost:3000`               |
| Institution_server            | `http://localhost:4000/api/v1/health` |
| Simulator AAI@EduHr           | `http://localhost:8090`               |
| Spremište dokaza (lokalni S3) | `127.0.0.1:4192`                      |
| PostgreSQL (Docker)           | `127.0.0.1:54329`, baza `ductus`      |

Front se pokreće skriptom `next:dev` iz njegova `package.json`; dok je nema (prije WEB-01), koristi se `dev`.

## Spremište dokaza i ključ za potpis (INT-08)

Završna predaja na commitu traži spremište dokaza i potpis potvrde, pa `pnpm lokalno` (a time i `stog:gore`) uz server pokreće i:

- **lokalni S3** (`scripts/stack/local-s3.ts`, kao u VS-1) na `127.0.0.1:4192`; objekti su datoteke u `.local/s3/`, pa preživljavaju ponovno pokretanje; pristupni ključ se svaki put izmisli iznova i živi samo u okolini procesa;
- **razvojni ključ za potpis**: sjeme od 32 bajta nastaje jednom u `~/.ductura/` (izvan repoa; potpisnik ga odbija unutar repoa), a javni ključ se upisuje preko `db/main/local/evidence-signing-key.sql` (bez nove migracije, ponovno pokretanje ne mijenja nijedan redak).

Serveru se u `serverEnv` dodaju `EVIDENCE_STORAGE_DOMAINS`, `EVIDENCE_S3_VS1_KEY_ID`, `EVIDENCE_S3_VS1_SECRET` i `DUCTUS_DEV_SIGNING_KEY_FILE`. Sve je samo lokalno (D-09): `NODE_ENV` je `development`, a varijable `EVIDENCE_*` i `VS1_*` iz vaše okoline se ne prosljeđuju. Lokalni S3 traži POSIX putanje (Linux, macOS, WSL); `pnpm stog:zdravlje` dodaje redak `s3`.

## Postavke (varijable okoline)

| Varijabla         | Zadano                            | Značenje                                                               |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------- |
| `STOG_FRONT_DIR`  | `../Institution_front_web_chrome` | Put do fronta (relativno na ovaj repo ili apsolutno)                   |
| `STOG_FRONT_PORT` | `3000`                            | Port fronta (1024 do 65535, ne `4000` ni `8090`)                       |
| `STOG_BAZA`       | `docker`                          | `vanjska`: ne dira Docker, koristi `DATABASE_URL` (kao `pnpm lokalno`) |

PostgreSQL iz `compose.yaml` (`postgres-main`, lokalne vrijednosti, port vezan na `127.0.0.1`) i `pnpm lokalno` rade migracije, prijave `ductus_app_local` i `ductus_auth_local` te seed; ponovno pokretanje je sigurno.

## Provjera zdravlja

`pnpm stog:zdravlje` ispisuje `OK` ili `NEMA` za: `postgres`, `oidc`, `server`, `front` i `front→server` (front proslijeđuje `/api/v1/health` serveru, dakle provjerava i spoj). Izlazni kod je 0 samo kad svi odgovaraju.

## Kad nešto ne radi

- „port … is in use”: stari stog još radi; `pnpm stog:dolje` (port `4192` je lokalni S3).
- Predaja na commitu vraća 503 u fazi spremišta ili potpisa: server je pokrenut bez `EVIDENCE_*`; pokreni ga kroz `pnpm lokalno` ili `pnpm stog:gore`.
- „run pnpm install in …”: u frontu nema `node_modules`.
- `front→server` je `NEMA`, a `server` je `OK`: front nema `/api/v1` proxy (WEB-02) ili `INSTITUTION_SERVER_URL` ne pokazuje na `:4000`.
- Docker nije dostupan: instaliraj PostgreSQL 16+ lokalno i pokreni s `STOG_BAZA=vanjska DATABASE_URL=postgres://postgres:<lozinka>@localhost:5432/ductus pnpm stog:gore`.

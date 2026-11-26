# Lokalno pokretanje (`pnpm lokalno`)

Institution_server s pravom prijavom preko simulatora AAI@EduHr, jednom naredbom, na Windowsu i Linuxu. Bez basha, WSL-a i Dockera. **Samo lokalni razvoj (D-09):** simulator je lažni OIDC pružatelj iz `packages/test-fakes/oidc/`; i on i server odbijaju ga izvan `NODE_ENV` `development` i `test`. Studenti se u svakom drugom okruženju prijavljuju isključivo preko AAI@EduHr.

Ugovor portova i toka je Ductus#2028, komentar 6993786629 (§1 i §3).

## Preduvjeti

- Node.js 24 i pnpm 10 (`corepack enable`), zatim `pnpm install`.
- PostgreSQL 16 ili noviji na ovom računalu (produkcija je 17). Na Windowsu instalacijski paket s postgresql.org; na Linuxu paket distribucije. Treba samo superkorisnik s lozinkom (npr. `postgres`); `psql` nije potreban.

## Pokretanje

PowerShell:

```powershell
$env:DATABASE_URL = "postgres://postgres:<lozinka>@localhost:5432/ductus"
pnpm lokalno
```

Linux:

```bash
DATABASE_URL='postgres://postgres:<lozinka>@localhost:5432/ductus' pnpm lokalno
```

Umjesto varijable `DATABASE_URL` može se jedan redak s istom adresom upisati u `.local/database-url`.

`DATABASE_URL` mora biti na `localhost`, `127.0.0.1` ili `[::1]`. Baza je uvijek `ductus` (u adresi smije biti `ductus`, `postgres` ili ništa); ako ne postoji, skripta je stvara.

Što skripta radi, redom:

1. Stvara bazu `ductus` ako je nema i provjerava da je PostgreSQL barem 16.
2. `db/main/local/migrator.sql` (uloga migratora i grupne uloge), zatim sve migracije kroz `scripts/db/migrate-locked.ts` (dbmate pod advisory lockom).
3. Prijave `ductus_app_local` (član `ductus_app`) i `ductus_auth_local` (član `ductus_auth`), s istim atributima kao `db/main/local/app-login.sql` i `auth-login.sql`, ali s generiranim lozinkama.
4. Izmišljene ustanove iz `db/main/local/seed.sql` (`demo.ductus.test`, `b.demo.ductus.test`) s issuerom `http://localhost:8090`.
5. `pnpm build` (`dist/server.js`).
6. Pokreće simulator na 8090 i server na 4000 i čeka da oba odgovore. Izlaz oba procesa ide u isti terminal s oznakom `[oidc]` ili `[server]`. Ctrl+C gasi oba; ako jedan stane, skripta gasi i drugi.

Ponovno pokretanje je sigurno: primjenjuju se samo nove migracije, a lozinke prijava vraćaju se na one iz `.local/`.

## Portovi

| Usluga                           | Adresa                  |
| -------------------------------- | ----------------------- |
| edge proxy (Preloader)           | `http://localhost:8000` |
| Institution_server               | `http://localhost:4000` |
| simulator AAI@EduHr (lažni OIDC) | `http://localhost:8090` |
| PostgreSQL                       | iz `DATABASE_URL`       |

Preglednik sve otvara preko edge proxyja na 8000 (Preloader `deploy/edge/dev-proxy.mjs`): `/api/v1/*` ide na server. Povratna adresa prijave je zato `http://localhost:8000/api/v1/auth/callback`, a `APP_ORIGIN` je `http://localhost:8000`.

Bez edge proxyja: `pnpm lokalno --izravno`. Tada je podrijetlo sam server (`http://localhost:4000`), pa prijava radi i bez Preloadera; front institucije tada ne dijeli podrijetlo sa serverom.

## Varijable servera

Server dobiva samo ove varijable (iz pozivateljeve okoline ne nasljeđuje ništa što upravlja bazom, prijavom ili portom):

| Varijabla                    | Vrijednost                                           |
| ---------------------------- | ---------------------------------------------------- |
| `NODE_ENV`                   | `development`                                        |
| `HOST`, `PORT`               | `127.0.0.1`, `4000`                                  |
| `APP_ORIGIN`                 | `http://localhost:8000` (`--izravno`: `:4000`)       |
| `APP_DATABASE_URL`           | `ductus_app_local` na bazu `ductus`                  |
| `AUTH_DATABASE_URL`          | `ductus_auth_local` na bazu `ductus`                 |
| `DUCTUS_AUTH_PROVIDER`       | `fake-oidc`                                          |
| `OIDC_ISSUER`                | `http://localhost:8090`                              |
| `OIDC_CLIENT_ID`, `_SECRET`  | `ductus-local`, `ductus-local-only` (javne, lokalne) |
| `OIDC_REDIRECT_URI`          | `http://localhost:8000/api/v1/auth/callback`         |
| `DUCTURA_PROVISIONING_TOKEN` | iz `.local/`                                         |

Baze logova i pravnih tekstova (`LOGS_DATABASE_URL`, `LEGAL_DATABASE_URL`) nisu dio ovog pokretanja; `/api/v1/health` ih javlja kao `nije_konfigurirano`, a prijava ih ne treba.

## Mapa `.local/`

Sve je u `.local/` u korijenu repoa, koji je u `.gitignore`. Ništa odavde ne ide u repo.

| Datoteka             | Sadržaj                                                                                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `lokalno-tajne.json` | Lozinke prijava `ductus_app_local` i `ductus_auth_local` i token provisioninga; stvara se jednom, `0600`. |
| `provisioning-token` | Isti `DUCTURA_PROVISIONING_TOKEN`, jedan redak, za lokalni Aplication_server (Ductus#2028 §2).            |
| `database-url`       | Neobavezno: `DATABASE_URL` kad nije u okolini.                                                            |
| `oidc-racuni.json`   | Neobavezno: imenovani računi simulatora (niže).                                                           |
| `nadzor.json`        | Dok `pnpm lokalno` radi: PID nadzornika, PID servera, naredba i mapa servera; bez okoline i tajni.        |

Nove tajne: obriši `lokalno-tajne.json` i pokreni ponovno. Oštećena datoteka zaustavlja pokretanje, nikad se ne zamjenjuje tiho.

### Ponovno pokretanje servera iz testa (VS-1.13, A06)

Kad bilo koji proces stoga izađe, `pnpm lokalno` gasi cijeli stog. Iznimka je najavljeno ponovno pokretanje servera, koje sistemski test web fronta koristi na Windowsu (`scripts/lokalno/nadzor.ts`):

1. Test upiše `.local/nadzor-server.stani` i ugasi proces servera. Na Windowsu je to uvijek tvrdo gašenje (TerminateProcess).
2. Nadzornik ne gasi stog, nego čeka zahtjev za pokretanje najviše 120 s.
3. Test provjeri da proces više ne postoji, da port 4000 ne sluša i da provjera zdravlja ne prolazi. Tada upiše `.local/nadzor-server.pokreni`.
4. Nadzornik pokreće istu naredbu s okolinom koju drži u memoriji i ažurira `nadzor.json`.

Svaki zahtjev vrijedi za jedno gašenje. Izlaz servera bez najave i dalje gasi cijeli stog. Na Linuxu (CI) se ovo ne koristi: tamo stog preuzima `stog-bez-nadzora.mjs` web fronta.

## Računi simulatora

Stranica simulatora („Demo prijava”) nudi tri vrste izmišljenih računa:

1. **Demo računi** (gumbi): ustanove iz `seed.sql`, `demo.ductus.test` i `b.demo.ductus.test`.
2. **Račun bilo koje ustanove** (obrazac): domena ustanove, uloga (`student` ili `nastavnik`) i neobavezno korisničko ime. Simulator izdaje `hrEduPersonHomeOrg` jednak domeni, `hrEduPersonUniqueID` `<korisnik>@<domena>` i `hrEduPersonAffiliation` `student` ili `djelatnik`. Nakon što admin na `/admin` doda ustanovu s domenom X (Ductus#2028 §2 i §3.4), račun iz X se prijavljuje bez ponovnog pokretanja.
3. **Imenovani računi** iz `.local/oidc-racuni.json`, kao gumbi; bez te datoteke simulator dobiva `db/main/local/lazni-oidc-racuni.json` s računima lokalnog seeda (README, „Lokalni računi”):

```json
{
  "racuni": [
    {
      "korisnik": "iva.p",
      "domena": "fpzg.hr",
      "uloga": "student",
      "ime": "Iva",
      "prezime": "Primjerić"
    },
    { "korisnik": "nastavnik", "domena": "fpzg.hr", "uloga": "nastavnik" }
  ]
}
```

`korisnik`, `domena` i `uloga` su obvezni; `ime` i `prezime` su neobavezni (zadano „Simulirani Student” ili „Simulirani Nastavnik”). Nepoznat ključ, neispravna domena ili ponovljeni račun zaustavljaju simulator s porukom koja navodi mjesto u datoteci. Datoteka se čita pri pokretanju, pa se nakon izmjene `pnpm lokalno` pokreće ponovno. Sva imena moraju biti izmišljena.

Prijava uspijeva samo za domenu koja u bazi ima ustanovu (`identity.institution.aai_home_org`) s issuerom `http://localhost:8090` (`identity.institution_issuer`). Za drugu domenu server odgovara neutralnom stranicom „Prijava nije dovršena” (403).

## Provjera

- `scripts/lokalno/config.test.ts`: portovi, issuer i povratna adresa ugovora, `DATABASE_URL`, tajne, okolina procesa i `seed.sql` bez psql zaštite.
- `scripts/lokalno/lokalno.integration.test.ts`: simulator kao zaseban proces s varijablama koje mu daje `pnpm lokalno`, rute prijave servera s varijablama servera, i tok login → simulator (obrazac i imenovani račun) → callback → kolačić `__Host-ductus_session`. Baza je u memoriji.
- `packages/test-fakes/oidc/simulated-accounts.test.ts`: obrazac, oznake računa i datoteka računa.

Cijeli tok na pravom PostgreSQL-u provjerava se ručno: `pnpm lokalno --izravno`, zatim u pregledniku `http://localhost:4000/api/v1/auth/login?returnTo=/app/web/ (preslikava se na /aplikacija/)`, prijava demo računom ili domenom iz `seed.sql`; odgovor callbacka je 303 na `/aplikacija/` s kolačićem sesije. Domena bez ustanove daje 403.

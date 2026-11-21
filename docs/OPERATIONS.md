# Pogon Institution_servera

Kostur pogonskog priručnika (plan M11.3, D-277 NQ03 i NQ06; SRV-1812). Opisuje što proces javlja o sebi, kako se pokreće i gasi i što smije biti u zapisu. Objava na Render i popis varijabli okoline su u [DEPLOY.md](DEPLOY.md); lokalni stog u [LOKALNO.md](LOKALNO.md). Odjeljci označeni „otvoreno” čekaju svoje korake plana (M11.2, M11.7, M11.9).

## 1. Živost i spremnost

| Ruta                 | Prijava | Što znači                                                                                                                                                                                          |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/health` | ne      | Proces odgovara. Uvijek `200`, uz `state: ok` ili `degraded` za glavnu bazu i verzije za predučitavač. Za health check platforme (Render, `HEALTHCHECK` u slici).                                  |
| `GET /api/v1/ready`  | ne      | Proces smije primati promet. `200` samo kad je glavna baza dostupna **i migracije su gotove**; inače `503` s `Retry-After: 5`, a za vrijeme gašenja `503` s `status: draining` i `Retry-After: 1`. |

Spremnost provjerava tri sposobnosti (`server/http/ready-capabilities.ts`), svaku s vlastitim rokom unutar ukupnih 3 s:

- `database` (obvezna): glavna baza odgovara i migracije su gotove. Bez nje ruta vraća `503`.
- `storage`: port pohrane dokaza (`EVIDENCE_STORAGE_DOMAINS`). Bez konfiguracije `nije_konfigurirano`; domena koja nije provjerena `nedostupno`.
- `signing`: port potpisa (javni ključ). Bez ključa `nije_konfigurirano`.

`storage` i `signing` se samo javljaju i ne vade repliku iz prometa; rute koje ih trebaju same vraćaju `503` (DAN-585). Odgovor nosi samo zatvorene riječi ugovora (`ok`, `nedostupno`, `nije_konfigurirano`), nikad poruku, adresu ni verziju.

### Kad su migracije „gotove”

Knjiga migracija `public.schema_migrations` pripada samo migratoru (D-91 mjera 6, pgTAP `db/main/tests/011-migration-ledger-access.sql`), pa je aplikacija ne čita. Spremnost čita samo katalog (`server/database/schema-readiness.ts`):

1. tablica knjige postoji, dakle migrator je barem jednom radio (inače kod `MIGRATIONS_MISSING`);
2. nijedna sesija ne drži savjetodavni lokot `scripts/db/migrate-locked.ts`, dakle migracija nije u tijeku (inače kod `MIGRATIONS_RUNNING`).

Poznata granica: prekinuto pokretanje migracija koje je otpustilo lokot ne razlikuje se od dovršenog. Usporedba s popisom migracija iz builda traži čitanje knjige, a to je vlasnikova odluka (otvoreno).

## 2. Provjera okoline pri pokretanju

`server/server.ts` provjerava okolinu prije nego što išta sluša. Za svaki problem ispiše jedan JSON redak na stderr i završi:

```json
{
  "time": "2026-11-21T08:00:00.000Z",
  "level": "error",
  "event": "startup.refused",
  "fields": { "problem": "APP_DATABASE_URL is not set" }
}
```

Redak imenuje varijablu, nikad njezinu vrijednost. Obvezna je samo `APP_DATABASE_URL`; ostale su neobvezne, ali postavljene moraju biti ispravne (`PORT`, `HOST`, `APP_ORIGIN`, `TRUSTED_PROXIES`, `SHUTDOWN_GRACE_MS`, `METRICS_INTERVAL_MS`, `DUCTURA_MODE`, datoteka ustanova). Popis i značenje varijabli: [DEPLOY.md](DEPLOY.md), „Varijable okoline”.

| Izlazni kod | Značenje                                                                                | Što napraviti                                                    |
| ----------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `0`         | uredno gašenje nakon SIGTERM ili SIGINT                                                 | ništa                                                            |
| `1`         | pokretanje nije uspjelo (`startup.failed`, npr. `EADDRINUSE`) ili gašenje je prešlo rok | pogledati kod u retku; zauzet port ili rok gašenja               |
| `78`        | okolina odbijena (`startup.refused`, EX_CONFIG iz `sysexits.h`)                         | ispraviti imenovanu varijablu; ponovno pokretanje samo ne pomaže |

## 3. Strukturirani zapis

Svaki redak procesa je jedan JSON objekt `{ time, level, event, fields }` iz `server/log/logger.ts`; `warn` i `error` idu na stderr, ostalo na stdout. Prije ispisa svaki dio prolazi kroz `redact` (`server/log/redact.ts`).

- **Nikad u zapisu:** e-pošta, ime i prezime, tekst rada, sadržaj dokumenta, kolačići, tokeni, lozinke, connection stringovi, potpisani URL-ovi. `redact` ih zamjenjuje s `[redacted]`; testovi `server/log/canary.test.ts`, `server/http/startup-log.test.ts` i `server/http/ready-capabilities.test.ts` to provjeravaju izmišljenim vrijednostima.
- **Događaji pokretanja:** `startup.refused`, `startup.failed`, `server.listening` (adresa i port na koji je proces sjeo).
- **Spremnost:** `ready.changed` jednom po promjeni ishoda, s `ready` i kodovima palih sposobnosti (npr. `MIGRATIONS_RUNNING`, `ECONNREFUSED`, `STORAGE_DOMAIN`). Ustaljeno stanje ne piše ništa, pa provjera svake sekunde ne puni zapis.
- **Baza zapisa:** zapisi iz kataloga događaja idu u `ductus_logs` kroz `server/log/writer.ts`; pri padu te baze ide samo rezervni redak s kodom.

## 4. Pokretanje, migracije i gašenje

1. Migracije se pokreću prije ili usporedno s novim procesom (`pnpm db:migrate` lokalno; produkcijski postupak je M11.2, otvoreno). Migracije se nikad ne primjenjuju na produkciju iz agenta.
2. Proces se pokreće i odmah odgovara na `/api/v1/health`; `/api/v1/ready` ostaje `503` dok migracije ne završe.
3. Prvi SIGTERM ili SIGINT: `/api/v1/ready` vraća `draining`, novi zahtjevi se ne primaju, započeti se dovršavaju u roku `SHUTDOWN_GRACE_MS` (zadano 8 s), zatim se zatvaraju baze i proces izlazi s `0`; što ostane nakon roka izlazi s `1`.

## 5. Otvoreno

- Produkcijski Dockerfile, Caddy i proba povrata: M11.2.
- Statusna stranica i postupak incidenta: M11.7 (javni status `server/http/public-status.ts` čeka DAN-839-3).
- Nadzor i uzbune iz vlastitih provjera (spremnost, worker, rok predaje): M11.9.
- Uz `database`, `storage` i `signing` ugovor spremnosti poznaje i `queue` (worker); sonda dolazi s workerom.

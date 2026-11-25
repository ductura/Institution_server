# Schemathesis proba ugovora (ISTR-7)

Proba šalje generirane zahtjeve na rute iz `openapi/v1.json` i provjerava odgovaraju li odgovori ugovoru: statusni kod, vrstu sadržaja, zaglavlja i shemu tijela te traži 5xx. Radi samo nad lokalnim stogom (`pnpm lokalno`), s lažnim OIDC računom `demo-student-3`. Nije dio `ci-ok`.

## Pokretanje

Schemathesis 4.34.2 se instalira izvan repoa, u vlastiti Python venv. Skripta odbija svaku drugu verziju.

```sh
# samotest: lažni poslužitelj, bez stoga
SCHEMATHESIS_BIN=<venv>/Scripts/schemathesis.exe node scripts/schemathesis/run.ts --samotest

# pokret nad lokalnim stogom (rub na :8000, lažni OIDC na :8090)
SCHEMATHESIS_BIN=<venv>/Scripts/schemathesis.exe node scripts/schemathesis/run.ts
```

Izvještaji (`report.json`, `requests.har.json`, `output.txt`, `sazetak.txt`) zapisuju se u `.local/schemathesis/<vrijeme>/`, koji je u `.gitignore`. Izlazni kod je:

- 0 kad je pokret valjan, i kad je našao neslaganja;
- 2 kad je pokret izašao iz opsega ili kad je kolačić završio u izvještaju;
- 1 kad pokret nije uspio (prijava, verzija, popis ruta).

## Opseg i zaštite

- **Popis ruta** je `STUDENT_READS` u `allowlist.ts`. Sadrži samo GET rute bez parametra putanje. Za svaku su handler i SQL funkcije provjereni: sve su `STABLE` i ne pišu. Namjerno su izostavljeni:
  - `/api/v1/notifications`, jer prva stranica može upisati podsjetnik o roku;
  - `/api/v1/me/self-note-key`;
  - `auth/*`, preuzimanja i izvozi.

  Rutu koja piše smijemo dodati tek kad proba dobije vlastiti stog.

- **Specifikacija se reže prije pokreta.** Schemathesis spaja zasebne `--include-*` filtre s ILI, pa sami filtri propuštaju druge operacije. Zato prima `spec-restricted.json` sa samo GET operacijama s popisa. U konfiguraciji je `phases.coverage.unexpected-methods = []`, inače bi faza pokrivenosti slala TRACE, PUT, POST i ostale metode.
- **Opseg se provjerava nakon pokreta.** `summary.ts` prolazi kroz HAR. Svaki zahtjev s drugom metodom, na drugo ishodište ili na rutu izvan popisa poništava pokret (`IZVAN OPSEGA`). Isto vrijedi i kad broj odabranih operacija nije jednak duljini popisa.
- **Kolačić sesije** ide samo kroz okruženje djeteta (`DUCTUS_ST_SESSION`, `${…}` u `schemathesis.toml`) uz `--output-sanitize true`. Nakon pokreta svaka datoteka izvještaja i ispis pretražuju se za vrijednost kolačića i za nefiltrirani `__Host-ductus_session=`. Ako se nađe, `output.txt` se ne sprema, a pokret završava kodom 2. Spremnik padova (`[cache] enabled = false`) i baza primjera (`--generation-database none`) su isključeni, pa Schemathesis ne piše zahtjeve u `.schemathesis/` u checkoutu.
- Provjere su samo one koje čitaju odgovor: `not_a_server_error`, `status_code_conformance`, `content_type_conformance`, `response_headers_conformance` i `response_schema_conformance`. Faze su examples, coverage i fuzzing, bez stateful. Ograničenja su jedan radnik, 20 zahtjeva u sekundi, 20 primjera po operaciji i 180 s.
- Schemathesis prije pokreta šalje dvije vlastite probe: GET na `/` i GET na `/schemathesis-probe…`, obje izvan API-ja.

**Samotest** pokreće lažni poslužitelj s dvije rute. `/api/v1/broken` vraća polje kojeg nema u zatvorenoj shemi, a `/api/v1/good` vraća ispravan odgovor. Uz njih postoje i operacije koje nisu na popisu (`POST /api/v1/good`, `GET /api/v1/outside`). Samotest prolazi samo ako vrijedi sve ovo:

- neslaganje je prijavljeno na `/broken` i nigdje drugdje;
- obje rute imaju 2xx;
- poslužitelj nije primio nijedan drugi zahtjev osim dviju proba;
- lažni kolačić nije ni u jednom izvještaju.

## Zapisani pokret (25. 11. 2026.)

Stog g-int32 (SRV `d5a5ac36`), rub `http://localhost:8000`, 22:10:58–22:14:01Z, izlazni kod 0.

Provjereno je 17 od 18 ruta na popisu (barem jedan odgovor 2xx). Ukupno je poslano 3141 zahtjev, bez ijednog 5xx i bez izlaska iz opsega.

| ruta                                                                                                                                    | zahtjeva | 2xx   | 4xx | 5xx |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------- | ----- | --- | --- |
| /api/v1/health, /ready, /status, /me, /profile/interface-locale, /settings/catalogue, /student/works, /student/assignments              | po 44    | po 44 | 0   | 0   |
| /api/v1/student/assignment-work, /assignment-submissions, /mentorships, /mentorship-requests, /mentor-candidates, /mentored-assignments | po 43    | po 43 | 0   | 0   |
| /api/v1/analysis/catalogue                                                                                                              | 44       | 0     | 44  | 0   |
| /api/v1/settings/values                                                                                                                 | 828      | 85    | 743 | 0   |
| /api/v1/notifications/returned-for-revision                                                                                             | 831      | 153   | 678 | 0   |
| /api/v1/notifications/mentorship-opened                                                                                                 | 828      | 157   | 671 | 0   |

**Neslaganja:**

- **ST103, nedokumentirani statusni kod:** `GET /api/v1/settings/values` (13 puta) i `GET /api/v1/notifications/returned-for-revision` (jednom) vratili su 429, kad je poslužitelj ograničio broj zahtjeva. Ugovor 429 ne navodi ni za jednu od tih ruta. Odbijeni nepoznati parametri upita (422) i 404 su u ugovoru.
- **`/api/v1/analysis/catalogue`** je u ugovoru, ali poslužitelj je ne poslužuje i uvijek vraća 404. Ugovor navodi 404, pa to nije prijavljeno kao neslaganje.

U bazi je u prozoru pokreta zapisana samo prijava i odjava probe: redak `identity.session` (otvaranje, `last_seen_at`, zatvaranje) i osvježeni `identity.person_name` pri prijavi. Ostala brojila u `pg_stat_user_tables` nisu se promijenila.

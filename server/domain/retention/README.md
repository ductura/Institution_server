# Klase podataka za čuvanje

SRV-1304 (plan M10.2 i M10.7, dio bez vlasnika). `catalog.ts` je katalog klasa podataka za čuvanje: sesije, stanje prikaza uživo, verzije (revizije i kontrolne točke), vrijeme po promjeni, zapis pristupa te hashevi i potvrde predaje. Svaka stavka navodi brojeve klasa iz Ductus `docs/privacy/06-klase-podataka.md` §2.

- Rok je odlučen samo za sesije: 30 dana nakon kraja (D-273 MQ08); briše ih posao workera `app.purge_ended_sessions` (SRV-1303), pa je njihov način `execute`.
- Svaki drugi rok čeka D-30 i zato je `null`. Klasa s rokom `null` uvijek je probni prolaz (`dry-run`): tip dopušta `execute` samo uz broj dana, a `retentionMode` i tada vraća `dry-run` za rok `null`. Prijelaz u brisanje traži promjenu ovog kataloga.
- Hashevi i potvrde (klasa 27) zasebna su klasa koja se ne briše i ne broji (D-272 MQ06).
- `retentionReport` od brojeva iz baze (`app.retention_candidates`, migracija `20261210130400_retention_dry_run.sql`) slaže odgovor rute `GET /api/v1/institution/retention`. `lastRunAt` je `null` dok se izvršeni prolazi ne bilježe.
- `label` je ključ poruke (`retention.*`); tekst je u katalogu klijenta.

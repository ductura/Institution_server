# Čitanje mjerila pilota

Jedan poziv `app.pilot_metrics()` preko `withActor` (migracija `20261201130000_pilot_metrics.sql`). Funkcija broji predaje, zahtjeve, potvrde i prijave problema do početka tekućeg dana (Zagreb), bez identifikatora i teksta, sama skriva male skupine i zaokružuje prikazane brojeve nadolje na višekratnik 5 (pgTAP `db/main/tests/208-pilot-metrics.sql`). Čitač to ponovno provjerava: redak s brojem koji nije 0 ni višekratnik 5 odbija kao neispravan, a `ZD401` vraća kao `unauthenticated`.

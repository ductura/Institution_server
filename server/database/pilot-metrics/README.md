# Čitanje mjerila pilota

Jedan poziv `app.pilot_metrics()` preko `withActor` (migracija `20261130110000_pilot_metrics.sql`). Funkcija broji predaje, zahtjeve, potvrde i prijave problema do početka tekućeg dana (Zagreb), bez identifikatora i teksta, i sama skriva male skupine (pgTAP `db/main/tests/204-pilot-metrics.sql`). Čitač to ponovno provjerava: redak s brojem od 1 do 4 odbija kao neispravan, a `ZD401` vraća kao `unauthenticated`.

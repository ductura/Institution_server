# Stanje sustava

Javni `GET /api/v1/status` prikazuje dostupnost pisanja, predaje i pregleda za mentora te do 50 aktualnih i budućih termina održavanja. Prazan popis znači da nema takvih termina. Izostavljeno polje `maintenanceWindows` znači da raspored trenutačno nije dostupan. Svaki proces ponovno koristi rezultat najviše 15 sekundi.

Operater izvan aplikacije u vlasničkoj ulozi `ductus_identity` upisuje `kind`, `starts_at` i `ends_at` u `identity.maintenance_window`. `planned` se koristi za najavljeno održavanje, a `outage` za potvrđeni završeni prekid. Vrijeme upisa zadano je vremenom baze. Operater može provjeriti vremenski raspon zabilježenog prekida pri odlučivanju o produljenju roka. Tablica nema slobodnog teksta ni identifikatora osobe, a javna ruta prikazuje samo vremena planiranih termina.

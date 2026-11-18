# server/backup

Područje iz [karte servera](../../docs/server-map.md). Rute, sheme i servis su još prazni (S-1A-a). Jedina logika je raspoređivač backupa (S-1G-a, DAN-1012-2).

## Što radi

Kopije baze i pohrane te mjesečna proba povrata (ARCHITECTURE §9). Feature područje: logika rute ili posla bit će u `service`.

## Raspoređivač backupa

`createBackupScheduler` (`scheduler.ts`) ima jedan satni timer koji kreće u `start()` i koji ništa ne pomiče: to je fiksna satna mreža (DAN-1012-2a, opcija A, Ductus#2028 c.6965242237). Na otkucaju čita postavke razine `system` iz kataloga (DAN-1012-1); otkucaj `busy` ne čita ništa. `run()` poziva samo kad je `backup.enabled` točno `true` i kad je prošlo barem `backup.interval_hours` otkucaja od zadnjeg poziva ili od zadnjeg otkucaja na kojem backup nije bio uključen. Ako ključ intervala nedostaje, vrijedi zadano iz kataloga.

Zato se `run()` poziva najviše jednom po intervalu mreže, a točno jednom kad posao završi unutar intervala. Trajanje posla, sinkrono ili asinkrono, ne pomiče sljedeći poziv. Čitanje postavki pomiče samo svoj poziv, unutar sata svojeg otkucaja. Ako tijekom čitanja kucne sljedeći otkucaj, poziva nema i javlja se `settings_unavailable`, pa nijedan poziv ne izlazi iz sata svojeg otkucaja. Otkucaji `busy`, `settings_unavailable` i `interval_invalid` mogu razmak samo produljiti.

Otkucaj koji samo čeka svoj sat ne javlja ništa. Svaki drugi otkucaj na kojem se posao ne pokrene javlja `onSkip` s jednim razlogom iz `BACKUP_SKIP_REASONS`, nikad s porukom ni vrijednošću:

- `settings_unavailable`: čitač baci, ne vrati pravi `Map` ili ne završi prije sljedećeg otkucaja;
- `enabled_missing`, `enabled_invalid`, `disabled`: backup nije uključen; otkucaji se broje ispočetka;
- `interval_invalid`: interval je izvan kataloga;
- `busy`: prethodni otkucaj još traje;
- `run_failed`: posao je bacio.

Kod `settings_unavailable` i `interval_invalid` otkucaji se i dalje broje. Brojač sati je u memoriji i ne ovisi o zidnom satu. Čitanje koje završi nakon `stop()` ne pokreće posao. `stop()` čeka posao u tijeku, ali ne i čitanje postavki. Posao ne smije čekati `stop()`, jer `stop()` čeka posao. Čitač, posao i primatelj razloga predaje sastavljač.

Poznate granice:

- Raspoređivač se još nigdje ne pokreće, pa je backup isključen (V-6 je vlasnikov).
- Kad unutar posla backup stvarno krene, odgovornost je posla. Raspoređivač vidi samo poziv `run()`, pa asinkrona priprema unutar posla može skratiti razmak između stvarnih početaka.
- Sporo čitanje (kraće od sata) pomiče svoj poziv, pa dva poziva u susjednim prozorima mogu biti bliža od intervala za trajanje tog čitanja.
- `settings.read_values` razinu `system` danas nikome ne daje.
- Više instanci bi svaka pokretale posao.
- Posao koji ne završi drži `busy`.

## Tko ga zove

`http` (status za administratora) i planirani posao. Planirani posao je pozadinski proces s vlastitim sastavljačem; dok ga nema, područje zove samo `http`, a raspoređivač nitko.

## Koje podatke dira

Kopije glavne baze i replika bucketa.

## Što izvozi

- `BACKUP_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `BACKUP_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `BackupService`: tip servisa bez članova (`service.ts`);
- `createBackupScheduler`, `BACKUP_CHECK_MS`, `BACKUP_SKIP_REASONS` i njihovi tipovi: raspoređivač (`scheduler.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, `log`, `metrics`, `domain`, `contracts`, `database`, `external/storage` i `external/keys`, i to kroz njihov `index.ts`. `database`, `external/storage` i `external/keys` uvozi samo s `import type` (tip porta); adapter mu predaje sastavljač (danas `http`). Ne uvozi `http` ni `test-server`. S drugim feature područjima dijeli podatke samo kroz bazu i RPC. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.

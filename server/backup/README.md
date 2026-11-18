# server/backup

Područje iz [karte servera](../../docs/server-map.md). Rute, sheme i servis su još prazni (S-1A-a). Jedina logika je raspoređivač backupa (S-1G-a, DAN-1012-2).

## Što radi

Kopije baze i pohrane te mjesečna proba povrata (ARCHITECTURE §9). Feature područje: logika rute ili posla bit će u `service`.

### Raspoređivač backupa

`createBackupScheduler` (`scheduler.ts`) radi na fiksnoj satnoj mreži od `start()` (DAN-1012-2b, opcija A, Ductus#2028 c.6965242237). Točka mreže k dospijeva u `start + k` sati po monotonom satu (`performance.now()`), a timer se uvijek postavlja na sljedeću točku. Zato ni posao ni čitanje ne pomiču mrežu. Točke koje blokirana petlja događaja propusti broje se odjednom. Nijedna točka se ne broji prije dospijeća: ako timer okine ranije (Node skraćuje razlomljenu odgodu), ponovno se postavlja na istu točku.

Na točki čita postavke razine `system` iz kataloga (DAN-1012-1); točka `busy` ne čita ništa. `run()` poziva samo kad je `backup.enabled` točno `true` i kad je prošlo barem `backup.interval_hours` točaka od zadnjeg poziva ili od zadnje provjere koja je na vrijeme vidjela da backup nije uključen. Ako ključ intervala nedostaje, vrijedi zadano iz kataloga.

Zato se `run()` poziva najviše jednom po intervalu mreže, a točno jednom kad posao završi unutar intervala. Posao koji završi unutar intervala, sinkron ili asinkron, ne pomiče sljedeći poziv. Dulji posao samo odgađa sljedeći poziv na prvu točku nakon svojeg kraja, a mreža ostaje ista. Čitanje postavki pomiče samo svoj poziv, unutar sata svoje točke. Čitanje koje završi u trenutku sljedeće točke ili kasnije ne poziva ništa i javlja `settings_unavailable`, bez obzira na to koji povratni poziv timera petlja izvrši prvi. Zato nijedan poziv ne izlazi iz sata svoje točke. Takvo kasno čitanje ne vraća brojanje na 0, ni kad je vidjelo da je backup isključen. Točke `busy`, `settings_unavailable` i `interval_invalid` mogu razmak samo produljiti.

Točka koja samo čeka svoj sat ne javlja ništa. Razlozi se isporučuju tek kad je odluka točke gotova i provjera pokrenuta (`queueMicrotask`, svaki poziv u svojem `try`). Zato primatelj ni trajanjem, ni bacanjem, ni pozivom `stop()` ne mijenja odluku točke. Svaka druga točka na kojoj se posao ne pokrene javlja `onSkip` s jednim razlogom iz `BACKUP_SKIP_REASONS`, nikad s porukom ni vrijednošću:

- `settings_unavailable`: čitač baci, ne vrati pravi `Map` (provjera kroz `Map.prototype`, pa vrijedi i `Map` iz drugog realma) ili ne završi prije sljedeće točke;
- `enabled_missing`, `enabled_invalid`, `disabled`: backup nije uključen; točke se broje ispočetka;
- `interval_invalid`: interval je izvan kataloga;
- `busy`: provjera još traje kad stigne povratni poziv točke, ili je točka dospjela dok je `run()` trajao, i kad njezin povratni poziv stigne tek nakon sinkronog posla (jednom za svaku točku). Vrijeme koje je potrošio primatelj razloga nikad ne čini točku `busy`;
- `run_failed`: posao je bacio.

Kod `settings_unavailable` i `interval_invalid` točke se i dalje broje. Brojač sati je u memoriji i ne ovisi o zidnom satu. Kad je `stop()` jednom pozvan, iz bilo kojeg povratnog poziva (`onSkip`, `readSettings`, `run`), ne počinje ni provjera, ni čitanje, ni poziv `run()`; čitanje koje završi nakon `stop()` ne pokreće posao. `stop()` čeka posao u tijeku, ali ne i čitanje postavki. Posao ne smije čekati `stop()`, jer `stop()` čeka posao. Čitač, posao i primatelj razloga predaje sastavljač.

Poznate granice raspoređivača:

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

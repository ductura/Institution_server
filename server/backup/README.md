# server/backup

Područje iz [karte servera](../../docs/server-map.md). Rute, sheme i servis su još prazni (S-1A-a). Jedina logika je raspoređivač backupa (S-1G-a, DAN-1012-2).

## Što radi

Kopije baze i pohrane te mjesečna proba povrata (ARCHITECTURE §9). Feature područje: logika rute ili posla bit će u `service`.

### Raspoređivač backupa

`createBackupScheduler` (`scheduler.ts`) radi na fiksnoj satnoj mreži od `start()` (DAN-1012-2c, opcija A, Ductus#2028 c.6965242237). Točka mreže k dospijeva u `start + k` sati po monotonom satu (`performance.now()`), a timer se uvijek postavlja na sljedeću točku. Zato ni posao ni čitanje ne pomiču mrežu. Točke koje blokirana petlja događaja propusti broje se odjednom. Nijedna točka se ne broji prije dospijeća: ako timer okine ranije (Node skraćuje razlomljenu odgodu), ponovno se postavlja na istu točku.

Na točki čita postavke razine `system` iz kataloga (DAN-1012-1); točka `busy` ne čita ništa. `run()` poziva samo kad je `backup.enabled` točno `true` i kad je prošlo barem `backup.interval_hours` točaka od zadnjeg poziva ili od zadnje provjere koja je na vrijeme vidjela da backup nije uključen. Ako ključ intervala nedostaje, vrijedi zadano iz kataloga.

Zato se `run()` poziva najviše jednom po intervalu mreže, a točno jednom kad posao završi unutar intervala. Posao koji završi unutar intervala, sinkron ili asinkron, ne pomiče sljedeći poziv. Dulji posao samo odgađa sljedeći poziv na prvu točku nakon svojeg kraja, a mreža ostaje ista. Čitanje postavki pomiče samo svoj poziv, unutar sata svoje točke. Čitanje koje završi u trenutku sljedeće točke ili kasnije ne poziva ništa i javlja `settings_unavailable`, bez obzira na to koji povratni poziv timera petlja izvrši prvi. Zato nijedan poziv ne izlazi iz sata svoje točke. Takvo kasno čitanje ne vraća brojanje na 0, ni kad je vidjelo da je backup isključen. Točke `busy`, `settings_unavailable` i `interval_invalid` mogu razmak samo produljiti.

Točka koja samo čeka svoj sat ne javlja ništa. Razlozi se isporučuju kao makrozadatak (`setImmediate`, svaki poziv u svojem `try`): iza odluke točke, iza nastavka već razriješenog čitanja i iza bilježenja kraja posla. Zato primatelj ni trajanjem, ni bacanjem, ni pozivom `stop()` ne mijenja te odluke. Ugovor porta: primatelj samo bilježi i ne blokira. Svaka druga točka na kojoj se posao ne pokrene javlja `onSkip` s jednim razlogom iz `BACKUP_SKIP_REASONS`, nikad s porukom ni vrijednošću:

- `settings_unavailable`: čitač baci, ne vrati pravi `Map` (provjera kroz `Map.prototype`, pa vrijedi i `Map` iz drugog realma) ili ne završi prije sljedeće točke;
- `enabled_missing`, `enabled_invalid`, `disabled`: backup nije uključen; točke se broje ispočetka;
- `interval_invalid`: interval je izvan kataloga;
- `busy`: provjera još traje kad stigne povratni poziv točke, ili je točka dospjela dok je `run()` trajao, i kad njezin povratni poziv stigne tek nakon sinkronog posla (jednom za svaku točku). Vrijeme koje je potrošio primatelj razloga nikad ne čini točku `busy`;
- `run_failed`: posao je bacio ili je njegovo obećanje odbijeno.

Kod `settings_unavailable` i `interval_invalid` točke se i dalje broje. Brojač sati je u memoriji i ne ovisi o zidnom satu. Kad je `stop()` jednom pozvan, iz bilo kojeg povratnog poziva (`onSkip`, `readSettings`, `run`), ne počinje ni provjera, ni čitanje, ni poziv `run()`; čitanje koje završi nakon `stop()` ne pokreće posao. `stop()` čeka posao u tijeku i razloge koji su već na putu do primatelja, ali ne i čitanje postavki. Posao ne smije čekati `stop()`, jer `stop()` čeka posao. Čitač, posao i primatelj razloga predaje sastavljač.

#### Kraj posla (DAN-1012-2e i 2f)

Ugovor porta je `run: () => void | Promise<void>` (Ductus#2028 c.6968668259). Rezultat `run()` prati se jednim putem. Prije poziva nastaje jedno izvorno obećanje ovog realma. Isti poziv koji bilježi kraj posla ujedno to obećanje razrješava, a posao, provjera i `stop()` čekaju samo njega. Rezultat se normalizira jednom:

- izvorni `Promise` iz bilo kojeg realma (`types.isPromise`) prati se kroz `Promise.prototype.then`, pa se njegov vlastiti `then` ne čita (vrijedi i za `Promise` iz `vm` konteksta s `then: undefined`);
- svakom drugom objektu ili funkciji `then` se čita jednom i odmah, u istom pozivu (DAN-1012-2f, QA FAIL na #312). Getter koji baci odmah daje `run_failed`, a `then` koji nije funkcija odmah završava posao, kao kod `await`. Inače `Promise.resolve` dobiva omotač koji zove već pročitani `then`, pa se `then` posla zove jedan mikrokorak kasnije i nikad se ne čita drugi put. Ono čime se thenable razriješi prati se istim pravilima na svakoj dubini: izvorni `Promise` kroz `Promise.prototype.then` (i s `then: undefined`), thenable kroz jednom pročitani `then`, a svaka druga vrijednost je samo kraj. Na svakoj razini vrijedi samo prvi poziv funkcija koje `then` posla dobije, pa kasniji poziv (npr. s odbijenim obećanjem koje je posao već obradio) ne ostavlja ništa neobrađeno (Codex i QA napadač na #314). Vrijednost ispunjenog obećanja nikad se ne prosljeđuje dalje (ni kod praćenja posla ni kod rezultata `onSkip`), pa se njezin `then` ne čita drugi put (QA FAIL na #314). `then` koji baci zatvara te funkcije jednako kao i prvi poziv, pa poziv koji je zakazao prije izbačaja nema učinka (Review FAIL na #314);
- sinkroni povrat koji nije objekt završava posao odmah, a sinkroni izbačaj odmah daje `run_failed`.

Izvorni `Promise` koji je razriješen najkasnije do povratka iz registracije reakcije (`then`) završava u tom trenutku, kao sinkroni posao. Trenutak se čita nakon `then`, jer `then` može pokrenuti getter `constructor` koji troši vrijeme ili razriješi obećanje (Review i QA FAIL na #312). Odmah iza reakcije stavlja se sonda (`queueMicrotask`). Reakcija na već razriješeno obećanje dolazi prije sonde, a svaka druga tek kad se obećanje razriješi, dakle iza nje. Zato mikrozadaci koje je drugi kod stavio u red prije reakcije ne pomiču kraj (QA napadač na #312).

`stop()` razloge na putu do primatelja broji i čeka bez ijedne statičke funkcije `Promise` (`Promise.all`, `Promise.resolve`), pa ga posao koji ih zamijeni ne može razriješiti prije isporuke `run_failed` (Review i QA FAIL na #312).

`Reflect.apply`, `Promise.prototype.then`, `Promise.resolve`, `types.isPromise` i `queueMicrotask` uzimaju se pri učitavanju modula. Svaku reakciju koju raspoređivač sam registrira (kraj posla, čišćenje provjere, `job`) registrira kroz uhvaćeni `then`, a ne kroz `.finally()` ili živi `.then` (DAN-1012-2f, Review i QA FAIL na #312). Obećanje koje `then` na izvornom `Promise`u izvodi kroz species označava se obrađenim, pa species koji ga učini odbijenim ne ostavlja neobrađeno odbijanje. `constructor` i `Symbol.species` obećanja jezik čita u trenutku poziva `then`.

**Granica ugovora (DAN-1012-2f):** portove (`readSettings`, `run`, `onSkip`) predaje sastavljač, kojem se vjeruje, i oni ne mijenjaju globalne ugrađene objekte (`Promise`, `Reflect`, `node:util`, timere, `performance`). Zaštita od posla koji ih namjerno mijenja nije u opsegu. Uhvaćene funkcije su dodatak, ne jamstvo: posao koji ostavi zamijenjen `Promise.prototype.then` (koji vraća `this` ili baca) testovima ne zaustavlja raspoređivač, ali druga promjena ugrađenih objekata može.

Poznate granice raspoređivača:

- Raspoređivač se još nigdje ne pokreće, pa je backup isključen (V-6 je vlasnikov).
- Kad unutar posla backup stvarno krene, odgovornost je posla. Raspoređivač vidi samo poziv `run()`, pa asinkrona priprema unutar posla može skratiti razmak između stvarnih početaka.
- Sporo čitanje (kraće od sata) pomiče svoj poziv, pa dva poziva u susjednim prozorima mogu biti bliža od intervala za trajanje tog čitanja.
- `settings.read_values` razinu `system` danas nikome ne daje.
- Više instanci bi svaka pokretale posao.
- Posao koji ne završi drži `busy`, a `stop()` ga čeka. Thenable koji se razrješava samim sobom vrti mikrozadatke bez kraja i drži petlju događaja, kao i `await`.
- Razrješenje obećanja koje je pri povratku još na čekanju vidi se tek u njegovoj reakciji. Ako je drugi kod prije `resolve()` stavio u red mikrozadatak koji traje, kraj se bilježi kasnije, pa točka može postati `busy` iako je posao završio malo prije nje. Jezik ne daje trenutak samog `resolve()`. Pogreška ide samo u sigurnom smjeru: poziv izostaje jedan interval, a drugi posao nikad ne kreće dok prvi traje. Test to veže.
- Kraj thenablea koji nije izvorni `Promise` (`PromiseLike`) bilježi se u reakciji na `Promise.resolve`. Njegov `then` poziva se tek jedan mikrokorak nakon povrata iz `run()`, a sve što thenable sam prosljeđuje kroz vlastiti lanac kasni još za te korake. Thenable koji javi kraj odmah, iza mikrozadatka koji je drugi kod stavio u red ranije, zato završava kasnije, pa točka može postati `busy` (siguran smjer; test to veže).
- Obećanje koje `then` izvodi kroz species označava se obrađenim samo na prvoj razini. Species tog izvedenog obećanja, ili species čije funkcije `resolve` i `reject` bacaju, mogu i dalje dati neobrađeno odbijanje ili izbačaj iz mikrozadatka. Rezultat `onSkip` označava se obrađenim, ali obećanje koje njegov species izvede ne označava se (kao ni kod `await`). To je promjena ugrađenog ponašanja `Promise`a, dakle izvan granice ugovora.
- Neke rezultate raspoređivač ne prati: izvorni `Promise` na kojem `Promise.prototype.then` baci (podklasa s nestandardnim konstruktorom, ili `constructor` ili `Symbol.species` koje je promijenio posao ili netko drugi), te `Proxy` izvornog `Promise`a i objekt koji ga nasljeđuje (njega bi se moglo pratiti preko prototipa, ali to bi bio drugi put). Oni se vode kao `run_failed` odmah, iako posao možda još traje, pa sljedeća točka može pozvati `run()` i `stop()` se može razriješiti prerano. Ako takvo obećanje kasnije bude odbijeno, odbijanje ostaje neobrađeno, a Node po zadanim postavkama tada prekida proces. Portove predaje sastavljač, kojem se vjeruje. Testovi te slučajeve vežu, pa svaka promjena ponašanja postaje odluka.
- Primatelj razloga radi u istoj niti. Ako blokira petlju, i nakon `await`, to se računa kao kašnjenje čitanja ili posla koji je u tijeku (pravilo kasnog čitanja), pa točka može ostati bez poziva. Zato primatelj mora samo bilježiti (Ductus#2028 c.6967461849, opcija C).
- Točka koju je blokirana petlja preskočila broji se, ali ne javlja razlog.

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

# server/database/queue

Workerova strana reda poslova na pg-bossu (DAN-820, VS-1b dio 1; plan napada ductura/server#146), prijenos Ductus `src/server/db/job-queue.ts` na `333e163`. Dio područja baze ([karta servera](../../../docs/server-map.md)); jedino mjesto u repou koje uvozi `pg-boss` (lint `database-boundary`).

## Što radi

`openJobQueue(settings)` otvara red za zadane vrste poslova (`JobDefinition` iz `server/domain/jobs`):

- red otvara samo prijava koja je isključivo član `ductus_worker`: bez povišenih atributa, bez prava gradnje u shemi `pgboss`, a sesija radi kao prijava koja se spojila (uloga iz `options` ne prolazi);
- `enqueue` u posao stavlja samo identifikatore; isti čuvar (`parseJobBody`) čita redak ponovno prije izvođenja, kao nepouzdan ulaz;
- `runOnce` uzima jedan posao, obradi daje rok i signal zaustavljanja, a ishod zapisuje za točno taj pokušaj (ID i broj pokušaja); pokušaj koji je sweep već vratio ništa ne mijenja (`lost`);
- ishod neuspjeha je samo zatvoreni kod (`[a-z][a-z0-9_]*`), nikad tekst iznimke ni rečenica paketa;
- `sweep` je jedna naredba: vraća pokušaje nakon isteka (kod `expired`) i briše što je prošlo rok čuvanja; paketove pozadinske radnje (supervizija, migracija, reindex) ne rade;
- red s drugim postavkama (rastući razmak ponovnih pokušaja, red mrtvih poslova, heartbeat, particija) odbija se.

Ograda pokušaja (`fence`) je obvezan port (tvornica čiji rezultat ima `arm` i `close`; inače `settings_invalid`): pokušaj koji je još u radu kad bi ga red mogao dati drugome završava proces. Ductus ima zadanu ogradu procesa (`src/server/attempt-fence.ts`, nit iz `node:worker_threads`). Ovdje je nit nadzora zaseban modul `attempt-fence-watch.ts` (DAN-822-4, odluka orkestratora Ductus#1836 c.6948159989), ne kod iz stringa: ograda je pokreće URL-om te datoteke i s njom dijeli jednu ćeliju (0 ili najraniji rok na monotonom satu); kad rok prođe, nit procesu šalje SIGKILL, i kad glavna nit blokira. Učitana izvan niti ili s krivom ćelijom baca `attempt_fence_watch_misused`. Lint `local/no-dynamic-load` toj datoteci, i samo njoj, dopušta uvoz `workerData` iz `node:worker_threads` i `process.hrtime`, `process.kill` i `process.pid` (`NODE_IMPORTS_ALLOWED`, `DYNAMIC_LOAD_ALLOWED`). Ograda je `startAttemptFence()` u `attempt-fence.ts` (DAN-822-5, prijenos Ductus `src/server/attempt-fence.ts` s istim ponašanjem): `arm(ms)` upisuje najraniji rok i vraća `release`, a `close()` gasi nit kad ništa nije naoružano; pokušaj koji je naoružan i dalje je ograđen dok se ne pusti. `arm` odbija (`fence_refused`) sve što nije cijeli broj od 1 do `MAX_FENCE_MS` (2³¹ − 1, kao `setTimeout`; dulji rok u nanosekundama ne stane u 64-bitnu ćeliju) i svaki `arm` nakon `close`. Nit pokreće samo kao `new Worker(new URL("./attempt-fence-watch.ts|js", import.meta.url), { workerData })`: `.ts` kad modul radi iz izvora, `.js` uz izgrađeni paket (DAN-822-6). Nit se pokreće samo izričitim pozivom `startAttemptFence()`, nikad pri uvozu modula; to dokazuje test izvođenja u `attempt-fence.test.ts` (`Worker` zamijenjen bilježnikom: nula niti nakon uvoza, jedna nakon poziva). Lint (`WORKER_SCRIPTS_ALLOWED`) dopušta `Worker` samo u tom obliku i samo u toj datoteci, bez `eval`, druge opcije ili koda iz stringa. Lint štiti od pogreške, ne od koda napisanog da ga zaobiđe (prepisan global poput `URL`, samouvoz pod drugim imenom); tu je zapreka review. Red ograde još ne dobiva od procesa workera (DAN-822-6/7), pa do tada red ne otvara nitko bez vlastite ograde.

## Tko ga zove

Samo proces workera (dolazi u VS-1b dio 2/3) i test `tests/db/job-queue.integration.test.ts`. Web proces ga ne uvozi: `server/database/index.ts` ovu mapu ne izvozi, pa web paket (`dist/server.js`) ne sadrži `pg-boss`.

## Koje podatke dira

Shemu `pgboss` u glavnoj bazi (`pgboss.job`, `pgboss.queue`), samo s pravima redaka koja ima `ductus_worker` (`db/main/tests/106-pgboss-queue.sql`). Ništa ne gradi: shemu su postavile migracije `20261108110*`.

## Što izvozi

`openJobQueue`, `JobQueueError`, `startAttemptFence`, `MAX_FENCE_MS` i tipove `AttemptFence`, `JobHandler`, `JobOutcome`, `JobQueue`, `JobQueueErrorCode`, `JobQueueSettings`. Kodovi `JobQueueError` su unutarnji kodovi workera i ne prikazuju se korisniku, kao ni `fence_refused` ograde.

## Što ne smije uvoziti

Kao područje baze: samo `settings`, `log`, `metrics` i `domain` (ovdje samo `domain`, kroz `server/domain/index.ts`), uz `pg` i `pg-boss`; `node:worker_threads` samo ograda (`Worker`) i nit nadzora (`workerData`), po popisima u `scripts/lint-rules/dynamic-load.ts`.

Testovi: `tests/db/job-queue.integration.test.ts`, 80 testova na pravom PostgreSQL-u (projekt `database`): 54 prenesena s istim tvrdnjama kao Ductus (58 na `333e163`) i 26 za ulaze koje pozivatelj mora dati (DAN-820, krug 2): ograda (izostavljena, `undefined`, nije tvornica, tvornica ne vrati `arm` i `close`), postavke, definicije i `onError` krivog oblika odbijaju se kodom prije ikakve veze, nikad kao `TypeError`, i red se ne stvara; `runOnce` bez obrade odbija `handler_invalid` prije nego što uzme posao. Četiri slučaja koja u dječjem procesu pokreću pravu ogradu procesa dolaze s njom. Ograda ima procesne testove u `attempt-fence.test.ts` (svi slučajevi Ductus `attempt-fence.test.ts` i odbijanja za `null`, `undefined`, BigInt, ±Infinity i rokove preko `MAX_FENCE_MS`). Nit nadzora ima vlastite testove u `attempt-fence-watch.test.ts` (dječji procesi s `SERVER_NODE_FLAGS`): pogrešna uporaba, SIGKILL kad rok prođe i kad nit blokira, i život procesa kad ništa nije naoružano.

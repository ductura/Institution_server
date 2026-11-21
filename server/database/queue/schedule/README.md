# server/database/queue/schedule

Raspored poslova u workeru nad postojećim pg-boss redom (SRV-1303, plan M10.0-S2; D-273 MQ08, MQ14) i port zadržavanja njegova prvog posla, `purge_ended_sessions`.

## Što radi

- `createJobSchedule()` vraća raspored. Svaki posao se registrira iz vlastitog direktorija pozivom `registerScheduledJob(definition)`; kasniji poslovi (probni prolaz, dnevni korijen) dodaju svoj direktorij i ne mijenjaju datoteke ovdje. Definicija se čita jednom u zamrznutu kopiju (getter se ne izvodi ponovno). Nakon `queueDefinitions()` ili prvog `run` raspored je zapečaćen.
- Svaki posao ima oznaku `mode: "execute" | "dry-run"`. Prije odluke D-30 samo poslovi s popisa `EXECUTE_ALLOWED` (zasad samo `purge_ended_sessions`) izvršavaju. Svaki drugi posao, i svaki čija oznaka nije točno `"execute"`, radi probni prolaz: raspored zove samo `candidates` i bilježi broj kandidata, a `execute` nikad ne zove.
- Termin (slot) je početak razdoblja posla na fiksnoj mreži (`everyMs`, cijele minute, od jedne minute do tjedan dana). U red ide samo ID termina (`slotId`): oblik UUIDv7 s početkom termina u prvih 48 bitova i ostatkom iz SHA-256 imena posla i početka. Tijelo prolazi `parseJobBody` pri upisu i prije izvođenja, pa tekst rada ni ključ ne ulaze u red (D-74).
- `run(queue, now)` za svaki posao stavi trenutni termin u red (jednom po terminu u procesu; red sam odbija drugi isti termin dok čeka ili radi) i izvede jedan posao. Posao radi za početak termina, nikad za sat u trenutku izvođenja, pa drugo izvođenje istog termina nema više što obrisati. Termin koji još nije počeo (`slot_in_future`), ID drugog posla (`invalid_slot`) i broj koji nije nenegativan cijeli broj (`invalid_count`) odbijaju se kodom.
- `createEndedSessionsPurge(client)`: poziv `app.purge_ended_sessions(p_before)` prijavom uloge `ductus_retention`. `purge` briše i vraća broj; `count` zove istu funkciju u transakciji koju uvijek vraća (ROLLBACK), pa probni prolaz broji točno ono što bi brisanje obrisalo i ništa ne mijenja. Greške su zatvoreni kodovi (`invalid_cut`, `invalid_count`, `purge_unavailable`), nikad tekst baze.

## Tko ga zove

Ulazna točka procesa workera (planirana, VS-1b): registrira poslove (npr. `registerPurgeEndedSessions` iz `server/session/purge-ended`), otvara red s `queueDefinitions()` i periodično zove `run`. Web proces ga ne zove.

## Koje podatke dira

Ništa izravno. Red poslova kroz port (`enqueue`, `runOnce`), a sesije samo kroz `app.purge_ended_sessions` (migracija `20261207100000`, pgTAP `181-purge-ended-sessions.sql`), koju smije izvršiti samo `ductus_retention`.

## Što izvozi

`createJobSchedule`, `effectiveMode`, `EXECUTE_ALLOWED`, `SLOT_FIELD`, `SLOT_MIN_MS`, `SLOT_MAX_MS`, `ScheduleError`, `ScheduledJobError`, `createEndedSessionsPurge`, `slotId`, `slotOf`, `slotStart` i tipove. `server/database/index.ts` ovu mapu ne izvozi i nijedna produkcijska datoteka izvan `server/database/queue/` je ne imenuje (`server/database/registry-boundary.test.ts`): uvozi je samo ulazna točka workera. Poslovi drugih područja zato pišu oblik definicije i porta kod sebe (strukturni tipovi).

## Što ne smije uvoziti

Kao područje baze: samo `domain` (ovdje `isJobDefinition`), `node:crypto` i tipove reda iz `../index.ts` (samo `import type`). Ne uvozi `pg-boss`.

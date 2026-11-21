# server/session/purge-ended

Prvi zakazani posao workera, `purge_ended_sessions` (SRV-1303, plan M10.0-S2; D-273 MQ08, MQ14).

## Što radi

Jednom dnevno (termin od ponoći UTC) briše retke `identity.session` čija je sesija završila (odjava, istek dvanaest sati ili dva sata neaktivnosti) više od 30 dana prije početka termina (D-200 P2). Granica je početak termina minus 30 dana, nikad sat u trenutku izvođenja, pa drugo izvođenje istog termina ne briše ništa. Posao ima oznaku `mode: "execute"` i jedini je na popisu `EXECUTE_ALLOWED` rasporeda; s bilo kojom drugom oznakom samo broji kandidate.

## Tko ga zove

Ulazna točka workera (planirana): `registerPurgeEndedSessions(schedule.registerScheduledJob, createEndedSessionsPurge(client))`, gdje je `client` veza prijave uloge `ductus_retention`.

## Koje podatke dira

Samo kroz port `EndedSessionsPort`, koji ulazna točka workera puni s `createEndedSessionsPurge` iz `server/database/queue/schedule` (`app.purge_ended_sessions`). Ne čita ni jedan redak sesije; vraća se samo broj.

## Što izvozi

`purgeEndedSessionsJob`, `registerPurgeEndedSessions`, `purgeCut`, `PURGE_ENDED_SESSIONS_JOB`, `PURGE_ENDED_SESSIONS_EVERY_MS`, `SESSION_RETENTION_MS` i tipove `EndedSessionsPort`, `PurgeEndedSessionsJob`, `RegisterJob` (oblik porta i definicije rasporeda).

## Što ne smije uvoziti

Ništa. Mapu reda (`server/database/queue/`) ne imenuje ni kao tip, jer je web proces ne smije učitati (`server/database/registry-boundary.test.ts`); oblik porta i definicije zato je napisan ovdje.

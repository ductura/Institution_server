# server/metrics

Područje iz [karte servera](../../docs/server-map.md). Rute, sheme i servis su za sada prazni (S-1A-a); jedina logika je obrazac poziva vanjske usluge (S-1E-c, DAN-837).

## Što radi

Brojači i trajanja za nadzor (zahtjevi, odbijanja, trajanje RPC-a).

`createExternalCaller(service, policy, deps)` (`external-call.ts`) je jedan obrazac poziva vanjske usluge za `storage`, `keys` i `email`: ukupni apsolutni rok (`timeoutMs`, ponavljanja uključena; nijedan pokušaj ne počinje u roku ili nakon njega, odgovor koji stigne nakon roka se odbacuje, a signal pokušaja prekida), ponavljanje samo za idempotentne operacije i samo kad stanka završava prije roka (`retries`, `retryDelayMs`), dostupnost (nakon `downAfter` uzastopnih padova usluga je `down` `downForMs` i poziv se ne šalje; zatim ide jedan probni poziv bez ponavljanja, a ostali pozivi ostaju `down` dok njegov ishod nije poznat) i jedan događaj `external_call` po pozivu sa zatvorenim poljima (`service`, `operation`, `outcome`, `attempts`, `durationMs`). Ni poruka, ni argument, ni odgovor usluge ne ulaze u događaj, pa ključ, lozinka ili adresa nemaju kamo. Obrazac je ovdje, uz trajanje i ishod koje mjeri, jer se adapteri u `external/` ne smiju uvoziti međusobno (karta, §2). `onEvent` smije biti asinkron; ni bačena greška ni odbijeno obećanje ne stižu do pozivatelja. Postavke iz okoline i vezanje događaja na `log` dolaze sa sastavljačem.

## Tko ga zove

`database`, `external/srce-auth`, `external/storage`, `external/keys`, `external/email`, `traffic`, `session`, `roles`, `legal`, `backup`, `deletion`, `downloads` i `http`.

## Koje podatke dira

Metrika u memoriji i njezin izvoz za nadzor. Bez osobnih podataka i sadržaja radova.

## Što izvozi

- `METRICS_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `METRICS_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `MetricsService`: tip servisa bez članova (`service.ts`);
- `createExternalCaller`, `EXTERNAL_SERVICES`, `EXTERNAL_CALL_OUTCOMES` i tipovi obrasca (`external-call.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, kroz njegov `index.ts`. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.

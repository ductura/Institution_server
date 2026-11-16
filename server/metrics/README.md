# server/metrics

Područje iz [karte servera](../../docs/server-map.md). Rute, sheme i servis su za sada prazni (S-1A-a); logika su obrazac poziva vanjske usluge (S-1E-c, DAN-837) i sakupljač metrika (S-1K.4-b, DAN-834).

## Što radi

Brojači i trajanja za nadzor (zahtjevi, odbijanja, trajanje RPC-a).

`createExternalCaller(service, policy, deps)` (`external-call.ts`) je jedan obrazac poziva vanjske usluge za `storage`, `keys` i `email`: ukupni apsolutni rok (`timeoutMs` od početka poziva, ponavljanja uključena; rok počinje prije pokretanja usluge, a asinkroni rad završava najkasnije na roku; pokušaj počinje samo dok ima vremena (prije roka), a odgovor vrijedi ako stigne do roka uključivo (`now() - start <= timeoutMs`), s tajmerom ili bez njega: istek prije `timeout` propusti jedan makrozadatak, pa o ishodu odlučuje vrijeme završetka pokušaja, a ne poredak utrke; odgovor koji stigne nakon roka se odbacuje, a signal pokušaja prekida; sinkroni rad adaptera ne može se prekinuti, pa događaj tada nosi stvarno trajanje, koje smije biti dulje od `timeoutMs`, i ishod `timeout`; zadani sat je monoton, pa skok sata zida ne pomiče rok), ponavljanje samo za idempotentne operacije i samo kad stanka završava prije roka (`retries`, `retryDelayMs`), dostupnost (nakon `downAfter` uzastopnih padova usluga je `down` `downForMs` i poziv se ne šalje; zatim ide jedan probni poziv bez ponavljanja, a ostali pozivi ostaju `down` dok njegov ishod nije poznat; poziv koji je počeo prije promjene dostupnosti samo javlja događaj i ne broji se, ne otvara ni ne zatvara stanje `down`) i jedan događaj `external_call` po pozivu sa zatvorenim poljima (`service`, `operation`, `outcome`, `attempts`, `durationMs`). Ulazi se provjeravaju prije poziva usluge (`RangeError`): usluga je s zatvorenog popisa, politika je običan zapis (prototip `Object.prototype` ili nijedan) s točno pet vlastitih cjelobrojnih ključeva (rok i stanka najviše 2^31 − 1 ms, granica tajmera), a caller čuva zamrznutu kopiju provjerenih vrijednosti, pa kasnija promjena objekta ne djeluje, `operation` je kod malim slovima, `options` su također običan zapis, a ponavljanje dopušta samo vlastito `retry: true`. Ni poruka, ni argument, ni odgovor usluge ne ulaze u događaj, pa ključ, lozinka ili adresa nemaju kamo. Obrazac je ovdje, uz trajanje i ishod koje mjeri, jer se adapteri u `external/` ne smiju uvoziti međusobno (karta, §2). `onEvent` smije biti asinkron; ni bačena greška ni odbijeno obećanje ne stižu do pozivatelja. Postavke iz okoline i vezanje događaja na `log` dolaze sa sastavljačem.

`createMetricsCollector({ intervalMs, collect, write, onSkip })` (`collector.ts`, DAN-834-1) svakih `intervalMs` pokreće jedan krug: `collect`, pa `write` onoga što je dao. Prvi krug je nakon prvog intervala; sakupljač ne čita sat zida, raspored drži samo tajmer, a tajmer ne drži proces živim (`unref`). Dok prethodni krug radi, novi se ne pokreće i javlja se `busy`; greška ili odbijeno obećanje iz `collect` ili `write` preskače krug (`collect_failed`, `write_failed`), a sljedeći krug ide normalno. `onSkip` dobiva samo kod s popisa `METRICS_SKIP_REASONS`, nikad poruku greške, i ni njegova greška ne izlazi iz sakupljača. `stop()` je konačan: gasi tajmer, čeka krug u tijeku i nikad se ne odbija. `intervalMs` je cijeli broj od 1 do 2^31 − 1 ms, a `collect`, `write` i zadani `onSkip` moraju biti funkcije, inače `RangeError` prije tajmera. Sakupljač ne uvozi ništa: izvore (zapis prometa, trajanje, veze na baze) i upis u `metric_sample` predaje sastavljač (DAN-834-2 i 834-3), jer `metrics` smije uvoziti samo `settings`. Sinkroni `collect` ili `write` koji blokira ne može se prekinuti; rok upisa nosi adapter.

## Tko ga zove

`database`, `external/srce-auth`, `external/storage`, `external/keys`, `external/email`, `traffic`, `session`, `roles`, `legal`, `backup`, `deletion`, `downloads` i `http`.

## Koje podatke dira

Metrika u memoriji i njezin izvoz za nadzor; uzorke za `metric_sample` piše funkcija koju predaje sastavljač. Bez osobnih podataka i sadržaja radova.

## Što izvozi

- `METRICS_ROUTES`: popis ruta, za sada prazan (`routes.ts`);
- `METRICS_SCHEMAS`: sheme, za sada prazne (`schemas.ts`);
- `MetricsService`: tip servisa bez članova (`service.ts`);
- `createExternalCaller`, `EXTERNAL_SERVICES`, `EXTERNAL_CALL_OUTCOMES` i tipovi obrasca (`external-call.ts`);
- `createMetricsCollector`, `METRICS_SKIP_REASONS` i tipovi `MetricsCollector`, `MetricsCollectorOptions`, `MetricsSkipReason` (`collector.ts`).

## Što ne smije uvoziti

Smije uvoziti samo `settings`, kroz njegov `index.ts`. Popis je u [karti servera, §2](../../docs/server-map.md#2-dopušteni-uvozi); provjeru u CI-ju uvodi S-1A-b.

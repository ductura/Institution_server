# server/log

Područje zapisa (karta: [docs/server-map.md](../../docs/server-map.md)).

## Što radi

Jedan strukturirani zapis web procesa i workera: svaki poziv piše točno jedan JSON redak `{ time, level, event, fields }`, a svaki dio retka prije toga prolazi kroz `redact`. Zapis nikad ne baca grešku pozivatelju.

- `redact.ts`: `redact(value)` uklanja tajne, tokene, osobne podatke i sadržaj radova iz vrijednosti bilo kojeg oblika (ključevi, tekst, URL-ovi, greške); `redactString`, `stripUrl`, `isSensitiveKey`.
- `logger.ts`: `createLogger(sink, now)`, `logEvent`, `codesLog` i `consoleSink` (stderr za upozorenja i greške, stdout za ostalo).
- `writer.ts`: servis zapisa (S-1K.3-a, DAN-807). `createLogWriter({ store, routes, fallback? })` vraća `write(input)`: zapis prvo provjerava katalog (`checkEvent`), zatim još jednom prolazi `redact`, i tek onda ide u port `LogStore` (`append(kind, payload)`, isti oblik kao lažna baza zapisa iz `@ductura/test-fakes`). Odbijen zapis se ne sprema; zapis koji `redact` mijenja također ne (`LOG_REDACTED`); polja vrste `route` i `routeOrNone` prije te provjere se prazne, a polje vrste `ip` izostavlja (DAN-831-1), a pad porta daje `LOG_STORE_FAILED`. `write` nikad ne baca; na rezervni zapis (konzola) ide samo fiksni događaj `log_refused` ili `log_store_failed` s kodom, nikad odbijena vrijednost ni poruka baze. Canary: `writer.integration.test.ts`.
- Pad baze zapisa (S-1K.3-b, DAN-812, plan napada ductura/server#109): `write` čeka `append` najviše `deadlineMs` (zadano `LOG_WRITE_DEADLINE_MS`, 1 s), pa daje `LOG_STORE_TIMEOUT`; kad `maxPending` zapisa (zadano `LOG_MAX_PENDING`, 64) još drži bazu, novi zapis ne ide u bazu (`LOG_STORE_BUSY`). Mjesto se oslobađa tek kad `append` stvarno završi. Kod `LOG_STORE_FAILED`, `LOG_STORE_TIMEOUT` i `LOG_STORE_BUSY` rezervni redak `log_store_failed` nosi `{ code, record }`: zapis je već prošao katalog i `redact`, pa se ne gubi tiho; logger ga još jednom propušta kroz `redact`, pa dug predložak rute (npr. `/api/v1/evidence/commit`) ondje može biti `[redacted]`. Isporuka je „barem jednom”: `append` koji uspije nakon roka ostavlja zapis i u bazi i u rezervnom retku. Adapter baze mora završiti svaki `append` (vlastiti rok upita), inače mjesta ostaju zauzeta i zapisi idu u rezervni redak (`LOG_STORE_BUSY`). Pisac nema `flush`; kad se `log` uveže u `server.ts`, gašenje mora pričekati ili ispisati zapise koji još čekaju. Pravi adapter za `ductus_logs` čeka tablicu (S-1K.2-a).
- `operator-audit.ts`: revizijski trag radnji operatora (S-1J.4, DAN-841, dio 841-1; ugovor Ductus#1836 c.6917244458). `createOperatorAudit({ write, now })` vraća `audited(actor, action, run)`: radnja vrsta 3–5 izvrši se samo ako njezin zapis `admin.action` prolazi katalog, i tada daje točno jedan pokušaj zapisa s ishodom (`succeeded` za `ok: true`, inače `failed`; bačena greška ide dalje nepromijenjena). Iz aktera se čitaju samo `requestId`, `accountKind`, `institutionId` i `userId` (UUID računa operatora, vrste 3–5; odluka vlasnika Ductus#2012 c.6917729838) kao vlastiti stringovi običnog objekta (nikad getter, Proxy ni ostali ključevi poput IP-a ili tokena), i to prije `run`; vrijeme je kraj radnje. Odbijen akter ili radnja daje `OPERATOR_AUDIT_REFUSED` bez radnje i bez zapisa; ustanova `null` se odbija. Zapis se ne čeka (zahtjev ne čeka zapis), a ovlasti ne provjerava (to je `server/roles`). Ime, e-pošta i IP nisu u zapisu; rok čuvanja i brisanje po roku su zaseban zadatak. Rute koje ga zovu dolaze u 841-3.
- `invented.fixture.ts`: izmišljene vrijednosti za testove (kanarinac `kanarinac`, domene `.test`), nikad stvarni podaci.
- `events/`: zatvoren katalog događaja i provjera zapisa (S-1K.1, DAN-796); opis je u [events/README.md](events/README.md).
- `analysis/`: pravila analize zapisa (S-1K.7-a, DAN-1010); opis je u [analysis/README.md](analysis/README.md).
- `index.ts`: javno sučelje mape.

Preneseno iz Ductusa `src/server/log/` (`d52a92c3`, S-0.17, DAN-730) bez promjene logike. Testovi: `redact.test.ts`, `canary.test.ts` i `redact.property.test.ts` (Ductus `tests/property/log-redact.property.test.ts`). Tri slučaja Ductus `canary.test.ts` čekaju kod kroz koji pišu: dokaze (`server/evidence`, S-M-\*) i ulaznu točku (S-1B-a); popis je u komentaru testa.

## Tko ga zove

Prema karti (§1): `database`, `external/srce-auth`, `external/storage`, `external/keys`, `external/email`, `traffic`, `session`, `roles`, `legal`, `backup`, `deletion`, `downloads`, `evidence`, `profile`, `institution`, `support` i `http`.

## Koje podatke dira

Bazu zapisa, samo preko porta `LogStore` (pravi adapter za `ductus_logs` čeka tablicu, S-1K.2-a), i rezervni redak na konzoli (`consoleSink`). Analiza (`analysis/`) ne dira ništa osim ulaza koji dobije.

## Što izvozi

`index.ts`: logger (`createLogger`, `logEvent`, `codesLog`, `consoleSink`), servis zapisa (`createLogWriter` i njegove konstante i tipove), revizijski trag operatora (`createOperatorAudit`), `redact` i pomoćne funkcije te katalog događaja iz `events/`. Analiza još nije u `index.ts` (nema pozivatelja do S-1K.7-b).

## Što ne smije uvoziti

Smije uvoziti samo `settings` (karta §2). Danas ne uvozi ništa iz drugih područja.

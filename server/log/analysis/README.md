# server/log/analysis

Pravila analize zapisa područja `log` (S-1K.7-a, DAN-1010; [karta servera](../../../docs/server-map.md)). Ugovor: Ductus#2028 c.6964677996.

## Što radi

`analyzeLog(entries, thresholds)` je čista funkcija koja u zapisima prepoznaje obrasce na razini sustava. Za svako pravilo poreda vremena njegovih događaja. Nalaz `{ rule, fromMs, toMs, count, minCount }` daje svaki poluotvoreni prozor `[t, t + windowMs)` koji počinje na zapisu i sadrži najmanje `minCount` zapisa. Sljedeća potraga počinje od prvog zapisa s vremenom `>= toMs`.

- Pravilo `login_failures` (ključ praga `loginFailures`, zadano 10 min i 20 zapisa) broji `authn.login_failed` i `authn.second_factor_failed`.
- Pravilo `traffic_refusals` (ključ praga `trafficRefusals`, zadano 5 min i 50 zapisa) broji `traffic.rate_limited` i `traffic.ip_denied` (DAN-1010-1b, ugovor Ductus#2028 c.6967029458).
- Pravilo `session_rejections` (ključ praga `sessionRejections`, zadano 5 min i 100 zapisa) broji samo `session.cookie_rejected` (DAN-1010-1c, ugovor Ductus#2028 c.6980590578). Stvaranje, istek i opoziv sesije su redovan tijek i ne broje se. Zadani prag je privremen: događaj još nitko ne piše, a razlog odbijanja (`reason`) se ne čita.
- Pravilo `authz_denials` (ključ praga `authzDenials`, zadano 10 min i 50 zapisa) broji `authz.denied`, `authz.operator_denied` i `authz.origin_rejected` (DAN-1010-1d, ugovor Ductus#2028 c.6981110138). Jedno pravilo za cijelu skupinu ovlasti je namjerno dok nema podataka o učestalosti. Zadani prag je privremen: danas piše samo `authz.operator_denied`, a razlog se ne čita. Zato se broje i `not_signed_in` (zahtjev bez sesijskog kolačića ili istek sesije u otvorenoj kartici) i `unavailable` (ispad provjere, ne odbijanje). Razdvajanje po razlogu je otvoreno pitanje iz tog ugovora.
- Pravilo `operation_failures` (ključ praga `operationFailures`, zadano 10 min i 20 zapisa) broji `external.call_failed`, `backup.failed` i `backup.restore_failed` (DAN-1010-1e, ugovor Ductus#2028 c.6982169225).
  - Ne broji `warning.raised`, jer su upozorenja izlaz analize (D-298), ni `error.unexpected` (programska greška).
  - Ne broji ni redovan tijek kopija, sporost (`external.call_slow`) ni mjerenja.
  - Zadani prag je privremen jer nijedan od tri događaja još nitko ne piše.
  - Polja se ne čitaju, pa se zbrajaju svi servisi i vrste. Neuspjesi kopija sami praktički ne dosežu prag, a zbroj (npr. 19 neuspjelih poziva i 1 neuspjela kopija) daje nalaz. Razdvajanje po servisu je otvoreno pitanje iz tog ugovora.
- Pragovi moraju imati ključ svakog pravila. Nalazi idu redom pravila, a unutar pravila po vremenu.
- Pragovi su parametar, a zadani su `DEFAULT_ANALYSIS_THRESHOLDS`. Svako polje praga je sigurni cijeli broj > 0, a prozor je najviše 24 h. Inače poziv daje `ANALYSIS_THRESHOLD_INVALID`; pragovi se provjeravaju prvi.
- Svaki ključ se čita jednom, kao vlastito podatkovno svojstvo. Getter, naslijeđena vrijednost, nositelj koji nije običan objekt (npr. funkcija) i čitanje koje baca (opozvani `Proxy`, zamka) vrijede kao nečitljivi.
- Nečitljiv zapis se preskače. Preskače se i zapis kojem vrijeme nije cijeli broj unutar granice `Date` (`MAX_TIME_MS`) ili mu događaj nije točno string iz pravila.
- Popis koji nije polje, koji baca, ili mu `length` nije cijeli broj od 0 do `MAX_ENTRIES`, daje `ANALYSIS_ENTRIES_INVALID`. Liste koje analiza gradi pišu se bez prolaska kroz `Array.prototype`, deskriptorom bez prototipa, pa im ni svojstva na `Object.prototype` ne smetaju. Tekstovi grešaka su u `locales/hr.json` pod `logAnalysis`. `analyzeLog` nikad ne baca, a rezultat je zamrznut.
- Analiza se nikad ne koristi za ocjenu studenta i ništa ne šalje nastavnicima: nalaz nema računa, IP-a, ocjene ni primatelja.

## Tko ga zove

Još nitko. Spajanje na poglede (S-1K.5-a) i na katalog postavki (S-1J-f) dolazi u kasnijem zadatku. Zato `server/log/index.ts` analizu još ne izvozi.

## Koje podatke dira

Samo ulaz koji dobije. Ne čita bazu, poglede, HTTP ni sat.

## Što izvozi

`analyzeLog`, `ANALYSIS_RULES`, `DEFAULT_ANALYSIS_THRESHOLDS`, `MAX_WINDOW_MS`, `MAX_TIME_MS`, `MAX_ENTRIES`, `ANALYSIS_ERROR_CODES` i njihove tipove.

## Što ne smije uvoziti

Ništa izvan područja `log` osim `settings` (karta §2). Iz `log` uvozi samo tip `EventKind` iz `../events/index.ts`.

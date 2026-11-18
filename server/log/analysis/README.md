# server/log/analysis

Pravila analize zapisa područja `log` (S-1K.7-a, DAN-1010; [karta servera](../../../docs/server-map.md)). Ugovor: Ductus#2028 c.6964677996.

## Što radi

`analyzeLog(entries, thresholds)` je čista funkcija koja u zapisima prepoznaje obrasce na razini sustava. Za svako pravilo poreda vremena njegovih događaja. Nalaz `{ rule, fromMs, toMs, count, minCount }` daje svaki poluotvoreni prozor `[t, t + windowMs)` koji počinje na zapisu i sadrži najmanje `minCount` zapisa. Sljedeća potraga počinje od prvog zapisa s vremenom `>= toMs`.

- Pravilo `login_failures` (ključ praga `loginFailures`) broji `authn.login_failed` i `authn.second_factor_failed`. Ostala pravila dolaze u 1010-1b i dalje.
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

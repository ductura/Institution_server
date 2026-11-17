# server/log/analysis

Pravila analize zapisa područja `log` (S-1K.7-a, DAN-1010; [karta servera](../../../docs/server-map.md)). Ugovor: Ductus#2028 c.6962315424.

## Što radi

Skup čistih funkcija koji u zapisima prepoznaje obrasce na razini sustava. `analyzeLog(entries, thresholds)` za svako pravilo poreda vremena zapisa njegovih događaja i vraća nalaz za svaki poluotvoreni prozor `[t, t + windowMs)` koji počinje na zapisu i sadrži najmanje `minCount` zapisa. Nalaz je `{ rule, fromMs, toMs, count, minCount }`; sljedeća potraga počinje od prvog zapisa s vremenom `>= toMs`, pa se prozori ne preklapaju.

- Pravila (1010-1): `loginFailures` (`authn.login_failed`, `authn.second_factor_failed`) i `trafficRefusals` (`traffic.rate_limited`, `traffic.ip_denied`). Sesije i ovlasti dolaze u 1010-2, pogon u 1010-3.
- Pragovi su parametar; zadani su `DEFAULT_ANALYSIS_THRESHOLDS`. Prag mora biti vlastito svojstvo s cijelim brojem većim od nule, prozor najviše 24 sata (`MAX_WINDOW_MS`); inače cijeli poziv daje `ANALYSIS_THRESHOLD_INVALID` (tekst u `locales/hr.json` pod `logAnalysis`).
- Vrijeme zapisa mora biti cijeli broj milisekundi unutar granice `Date` (`MAX_TIME_MS`, ±8,64 · 10¹⁵), pa je kraj prozora uvijek točan. Zapis bez takvog vlastitog `timeMs` ili vlastitog stringa `event` (getter, naslijeđen ključ) se preskače; događaj se uspoređuje točno, bez rezanja razmaka i promjene velikih slova.
- Analiza se nikad ne koristi za ocjenu studenta i ništa ne šalje nastavnicima: nalaz nema računa, IP-a, ocjene ni primatelja.

## Tko ga zove

Još nitko. Spajanje na poglede (S-1K.5-a, DAN-835) i katalog postavki (S-1J-f, DAN-806) je kasniji zadatak (S-1K.7-b); `server/log/index.ts` analizu zato još ne izvozi.

## Koje podatke dira

Samo ulaz koji dobije (lokalni tip `AnalysisEntry`: vrijeme i vrsta događaja). Ne čita bazu, poglede, HTTP ni sat.

## Što izvozi

`analyzeLog`, `ANALYSIS_RULES`, `DEFAULT_ANALYSIS_THRESHOLDS`, `MAX_TIME_MS`, `MAX_WINDOW_MS`, `ANALYSIS_ERROR_CODES` i njihove tipove.

## Što ne smije uvoziti

Ništa izvan područja `log` osim `settings` (karta §2); iz `log` uvozi samo tip `EventKind` iz `../events/index.ts`.

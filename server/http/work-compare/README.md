# server/http/work-compare

## Što radi

`GET /api/v1/works/{documentId}/compare?from=&to=` (`work.compare.get`, SRV-2004) vraća razliku po blokovima između dviju revizija rada, u obliku razlike iz `work.versions.get` (klijent `time-machine` u webu). Tekst obiju revizija server rekonstruira iz evidencije (`server/evidence/compare`), ne iz spremljenih tekstova. Rubna razina: kolačić (401), neispravan id (404), točno upit `from` i `to` s `from < to` (422), ishod usporedbe u status. Ni djelomičan odgovor: nepročitan zapis ili prevelika usporedba je 503.

## Tko ga zove

`server/server.ts` montira rutu. Vlasnik rada i nastavnik zadatka dobivaju isti odgovor.

## Koje podatke dira

Ništa ne piše osim retka dnevnika pristupa nastavnika, koji zapisuje izvor reprodukcije u istoj transakciji čitanja. Čita zapis evidencije i objekte segmenata u pohrani ustanove.

## Što izvozi

`createWorkCompareRouteFor`, `createWorkCompareRoute`.

## Što ne smije uvoziti

Upotrebljava javna sučelja područja iz [Karte servera](../../../docs/server-map.md).

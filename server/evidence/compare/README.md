# server/evidence/compare

Usporedba dviju verzija jednog rada (SRV-9E, Ductus#2028), dio područja `evidence` iz [Karte servera](../../../docs/server-map.md).

## Što radi

`compareWorkVersions(deps, documentId, from, to)` vraća razlike između revizije `from` i revizije `to` (`from < to`) po blokovima teksta (odlomak, naslov s razinom, stavka popisa, citat):

- oba teksta server rekonstruira iz evidencije, ne iz spremljenih tekstova kontrolnih točaka: segmente koje izvor navodi čita iz pohrane ustanove, svaki provjerava kao reprodukcija (kanonski oblik, navedeni hash, prethodni segment, isti dokument) i ponavlja ih od revizije 0 serverskim replayerom koraka koji daje pozivatelj (`deps.replayers`: `ductus-edit-steps-v1` nad dokumentom v1 i `ductus-edit-steps-v3` nad dokumentom v3, iz `external/storage`; `evidence` ga smije uvesti samo kao tip);
- replayer za svaki uklonjeni raspon provjerava zapisani `removedSha256` (B-12), pa nijedan tekst ne izlazi mimo te provjere;
- revizija r je dokument nakon prvih r segmenata: baza podiže reviziju samo kad prihvati segment jedinog paketa rada, jednu po segmentu;
- prekid u zapisu prije revizije `to` je `unavailable` (`record_break`): usporedba uvijek kreće od revizije 0 i ne nastavlja od kontrolne točke;
- pristup, presjek na predanoj reviziji i redak dnevnika pristupa nastavnika dolaze s izvorom reprodukcije (`app.read_replay_source`); vlasnik i nastavnik zadatka dobivaju isti odgovor (Ductus `docs/PRODUCT.md` §5 pravilo 5);
- razlika po blokovima je `diffBlocks` nad `blocksOf` obaju tekstova (opis niže).

`blocksOf(canonical)` čita kanonski dokument kao blokove u redoslijedu (odlomak, naslov s razinom, stavka popisa, citat) sa spojenim tekstnim čvorovima; drugi umetnuti čvorovi ne dodaju znak, a nepoznat oblik daje `null`. `diffBlocks(before, after)` vraća svaki blok obiju verzija jednom, kao nepromijenjen, uklonjen ili dodan, računato na onome što se prikazuje (vrsta, razina naslova, tekst): zajednički početak i kraj ostaju nepromijenjeni, a sredina je najdulji zajednički podniz blokova; uklonjeni blok dolazi prije dodanog na istom mjestu.

Granice veličine ulaza: kasnija revizija najviše `MAX_COMPARE_SEGMENTS` (10 000), pročitano najviše `MAX_COMPARE_READ_BYTES` (128 MiB), svaka verzija najviše `MAX_COMPARE_BLOCKS` (5000) blokova; iznad toga `too_large`. Kad tablica sredine prelazi `MAX_COMPARE_DIFF_CELLS`, sredina se daje cijela kao uklonjena pa dodana (točan, dulji odgovor).

Ishodi su vrijednosti: `ok`, `invalid_input` (prije čitanja), `not_found` (tuđi, nepostojeći ili neispravan rad i revizija izvan zapisa, C-23), `unauthenticated`, `too_large`, `unavailable` sa zatvorenim razlogom za zapis servera.

Poznate granice: promjena koja ne dodaje znak (oznaka, navod u v2 i v3, fusnota) nije razlika; rad dokumenta v2 nema serverski replayer za svoj format pa je `unavailable`, kao i rekonstrukcija predaje; replayer v3 još se ne izvozi kroz `server/external/storage/index.ts`, pa ga HTTP adapter dobiva tek s tim izvozom (do tada je rad v3 `unsupported_format`); potvrde segmenata ovdje se ne provjeravaju (provjerava ih predaja). Koje revizije ruta smije primiti otvoreno je pitanje (Ductus#2028, c.7041794229; `docs/PRODUCT.md` §5 pravilo 7).

## Tko ga zove

HTTP adapter rute usporedbe u `server/http` (sljedeći korak).

## Koje podatke dira

Ništa ne piše. Čita izvor reprodukcije glavne baze kroz `ReplaySource` iz `server/database` i objekte segmenata u pohrani ustanove.

## Što izvozi

`compareWorkVersions`, `blocksOf`, `diffBlocks`, granice `MAX_COMPARE_SEGMENTS`, `MAX_COMPARE_READ_BYTES`, `MAX_COMPARE_BLOCKS`, `MAX_COMPARE_DIFF_CELLS` i tipove `CompareDeps`, `CompareResult`, `CompareUnavailableReason`, `CompareBlock`, `CompareChange`, `CompareEntry`.

## Što ne smije uvoziti

Ništa izvan dopuštenog za `evidence` u karti servera: `domain`, tipove iz `database` i `external/storage` (replayere samo kao tip, daje ih pozivatelj) i `isReplayDocumentId` iz `server/evidence/index.ts`.

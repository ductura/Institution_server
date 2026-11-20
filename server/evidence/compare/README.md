# server/evidence/compare

Usporedba dviju verzija jednog rada (SRV-9E, Ductus#2028), dio područja `evidence` iz [Karte servera](../../../docs/server-map.md).

## Što radi

Prvi korak: blokovi teksta rekonstruiranog dokumenta i razlika između dviju verzija po blokovima. Rekonstrukcija obiju verzija iz evidencije dolazi u sljedećem koraku.

- `blocksOf(canonical)` čita kanonski dokument (JCS tekst kojim reprodukcija završava) kao blokove u redoslijedu dokumenta: odlomak, naslov s razinom, stavka popisa i citat, svaki sa svojim tekstom. Tekst bloka su spojeni tekstni čvorovi; drugi umetnuti čvorovi (navod, fusnota, unakrsna poveznica) ne dodaju znak. Oblik koji ne poznaje daje `null`, nikad pogađanje.
- `diffBlocks(before, after)` vraća svaki blok obiju verzija jednom, kao nepromijenjen, uklonjen ili dodan. Razlika se računa na onome što se prikazuje (vrsta, razina naslova, tekst): zajednički početak i kraj ostaju nepromijenjeni, a sredina je najdulji zajednički podniz blokova; uklonjeni blok dolazi prije dodanog na istom mjestu.

Granice veličine: verzija s više od `MAX_COMPARE_BLOCKS` (5000) blokova je prevelika za usporedbu (provjerava je sljedeći korak). Kad tablica sredine prelazi `MAX_COMPARE_DIFF_CELLS` (4 000 000) ćelija, sredina se daje cijela kao uklonjena pa dodana: točan, dulji odgovor.

Poznata granica: promjena koja ne dodaje znak (oznaka, navod u v2 i v3, fusnota) nije razlika.

## Tko ga zove

Usporedba verzija u ovoj mapi (sljedeći korak), a nju HTTP adapter rute usporedbe u `server/http`.

## Koje podatke dira

Ništa: čista funkcija nad tekstom dokumenta, bez I/O-a.

## Što izvozi

`blocksOf`, `diffBlocks`, `MAX_COMPARE_BLOCKS`, `MAX_COMPARE_DIFF_CELLS` i tipove `CompareBlock`, `CompareChange`, `CompareEntry`.

## Što ne smije uvoziti

Ništa izvan dopuštenog za `evidence` u karti servera; ovaj dio ne uvozi ništa.

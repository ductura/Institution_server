# ADR: ugovor izlaza iz usluge (paket i manifest)

SRV-1810 `izlaz-iz-usluge-ugovor`, plan M10.6-P01 (F-04), D-274 MQ12, Ductus DAN-416.

**Status: PRIJEDLOG.** Ovo je samo ugovor. Posao izvoza, konzola i predaja paketa (M10.6-P02 i P03) idu nakon pilota, a prije njegova kraja, i nisu dio ovog koraka. Ovdje nema tablice, RPC-a, rute, posla ni teksta sučelja.

Kod je u [`server/contracts/institution-exit/`](../../server/contracts/institution-exit/): TypeBox sheme, tipovi i `checkInstitutionExitManifestV1`, s testovima.

## Kontekst

- **D-274 MQ12:** izlaz pokreće operater (konzola, D-262 Q06) na pisani zahtjev ustanove, paket se predaje imenovanom primatelju s manifestom, a izlaz ne pokreće brisanje.
- Slika A-08 (`m10-admin-reference`): na stranici ustanove nema gumba koji pokreće izlaz. Potvrda je zapis o predaji paketa (primatelj, otisak manifesta, „Podaci u Ducturi nisu obrisani.”).
- Izlazna odredba ugovora o obradi (D-264 Q13) je otvorena (radnja vlasnika).

## Odluka

1. **Tko pokreće.** Samo operater Ducture, na pisani zahtjev ustanove. U manifestu je `startedBy` doslovno `"operator"`. Administrator ustanove, nastavnik, student i referada ne pokreću izlaz i ne dobivaju rutu za to. Zahtjev (`InstitutionExitRequestV1`) nosi `institutionId`, referencu pisanog zahtjeva (broj iz urudžbenog zapisnika, najviše 120 znakova, bez teksta dopisa) i oznaku primatelja; bez adrese, računa i osobnih podataka.
2. **Što se ne briše.** Izlaz samo čita. `deletesNothing` je doslovno `true` u manifestu, a `deletion` doslovno `"none"` u zapisu predaje. Izlaz ne mijenja rokove čuvanja, ne skida pravno zadržavanje i ne dira hash-eve i potvrde (klasa 27). Zatvoren popis `INSTITUTION_EXIT_NEVER_V1` to imenuje, a test ga pribija.
3. **Oblik paketa.** `manifest.json` i `data/<ime>.jsonl` (ili `.bin` za privitke). Manifest `ductura-institution-exit-v1`: `exitId`, `institutionId`, referenca zahtjeva, primatelj, `generatedAt`, `deletesNothing` i popis datoteka (`path`, `dataClass` 1 do 30, `rowCount`, `byteLength`, `sha256`). Datoteke su poredane po putanji (redoslijed kodnih jedinica) i bez duplikata; svih 30 klasa podataka ima barem jednu datoteku (prazna klasa je datoteka s `rowCount` 0, da primatelj razlikuje „nema” od „izostavljeno”). Hash manifesta čuva se uz manifest, nikad u njemu.
4. **Zapis predaje.** `InstitutionExitHandoverV1`: `exitId`, `manifestSha256`, primatelj, vrijeme predaje i `deletion: "none"`. To je jedino što se zapisuje pri predaji.
5. **Stanja.** `requested`, `running`, `ready`, `handed_over`, `failed`; nema stanja brisanja.
6. **Nema rute za korisnike.** Ugovor ne dodaje rutu u `ROUTES` ni u `openapi/v1.json`; test to provjerava. Ruta operaterske konzole dolazi s P02.

## Pretpostavke

- Popis klasa je 30 klasa iz Ductus `docs/privacy/06-klase-podataka.md` §2; ugovor ih identificira brojem i ne uvozi katalog iz drugog područja.
- „Manifest DAN-341” iz odluke MQ12 nije bio dostupan oblaku, pa je oblik manifesta najmanji razuman, po uzoru na manifest uvoza ([import-contract.md](import-contract.md)). Ako DAN-341 traži drugačija polja, mijenja se ovaj ugovor prije P02.
- Ograničenja (najviše 200 datoteka, duljine oznaka) su prijedlog; granica veličine paketa i način predaje (kanal, šifriranje) odlučuju se u P02 i P03.

## Otvoreno

- Izlazna odredba ugovora o obradi (D-264 Q13), radnja vlasnika.
- Potvrda ovog ugovora prije P02.

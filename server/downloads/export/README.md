# server/downloads/export

Izvoz rada (DOCX, `.pptx` slajdova; PDF slijedi) u području [preuzimanja](../README.md). SRV-10D, val 10.

## Što radi

Iz dokumenta v4 (`CanonicalDocumentV4`) izvodi blokove za ispis (`buildExportModel`): brojeve poglavlja, ispisa koda, okvira i formula po redoslijedu pojavljivanja (ugovor v4, §8), naslov iz prvog naslova razine 1. `renderDocx` slaže naslovnicu i blokove u DOCX, uključujući tablice (naslov, zaglavlje, pruge, boje, spajanje ćelija, izvor) i slike (privitak provjeren hashom, obrezivanje, širina, poravnanje, izvor); vodoravna tablica ili slika stoji u vlastitom odjeljku (`landscape`). Isti ulaz daje iste bajtove (ZIP bez sažimanja, fiksno vrijeme).

Oblik stranice (`PageSetup`) i podaci naslovnice (`ExportCover`) dolaze od pozivatelja iz profila pravila fakulteta, zadatka i prijave; dokument ih ne nosi (ugovor v4, §7). Riječi koje izvoz ispisuje (`ExportLabels`) dolaze iz kataloga poruka, ne iz koda.

`renderSlidesPptx` (SRV-V13-IZVOZ-PPTX) iz zamrznute snimke slajdova (točni JCS bajtovi, `verifySlidesSnapshot`) i bajtova slika gradi `.pptx` (OOXML: prezentacija, master, četiri rasporeda, slajdovi, bilješke govornika, slike); `buildSlidesExportModel` izvodi naslove, brojeve i regije po rasporedu. Slika se ispisuje samo ako joj se SHA-256 slaže s onim u dokumentu; nedostajuća, zamijenjena ili nečitljiva slika (samo PNG i JPEG) zaustavlja izvoz sa zasebnim ishodom. Riječi iz `slidesExport` kataloga. Nema API-ja; ruta i PDF su SRV-V13-RUTA-IZVOZ.

## Tko ga zove

Poslužiteljski adapter koji je prethodno provjerio pristup radu i pročitao dokument.

## Koje podatke dira

Samo ulaz funkcija. Ne otvara bazu, pohranu ni mrežu.

## Što izvozi

`buildExportModel`, `renderDocx`, `A4_PAGE`, `writeZip` (deterministički ZIP; paket za Merlin, SRV-1110) i tipovi iz `index.ts`.

## Otvorene stavke

Bajtovi privitaka slika još se ne čitaju iz pohrane (tablica privitaka je zaseban SRV zadatak): `renderDocx` prima `images` (id privitka u bajtove), a bez njih ili uz neslaganje SHA-256 slika se ispisuje kao nedostupna; navodi, fusnote i unakrsne poveznice u izvozu; ruta i ugovor `/api/v1`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md): `domain` kroz `index.ts`.

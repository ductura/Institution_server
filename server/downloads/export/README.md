# server/downloads/export

Izvoz rada (DOCX; PDF slijedi) u području [preuzimanja](../README.md). SRV-10D, val 10.

## Što radi

Iz dokumenta v4 (`CanonicalDocumentV4`) izvodi blokove za ispis (`buildExportModel`): brojeve poglavlja, ispisa koda, okvira i formula po redoslijedu pojavljivanja (ugovor v4, §8), naslov iz prvog naslova razine 1. `renderDocx` slaže naslovnicu i blokove u DOCX. Isti ulaz daje iste bajtove (ZIP bez sažimanja, fiksno vrijeme).

Oblik stranice (`PageSetup`) i podaci naslovnice (`ExportCover`) dolaze od pozivatelja iz profila pravila fakulteta, zadatka i prijave; dokument ih ne nosi (ugovor v4, §7). Riječi koje izvoz ispisuje (`ExportLabels`) dolaze iz kataloga poruka, ne iz koda.

## Tko ga zove

Poslužiteljski adapter koji je prethodno provjerio pristup radu i pročitao dokument.

## Koje podatke dira

Samo ulaz funkcija. Ne otvara bazu, pohranu ni mrežu.

## Što izvozi

`buildExportModel`, `renderDocx`, `A4_PAGE`, `writeZip` (deterministički ZIP; paket za Merlin, SRV-1110) i tipovi iz `index.ts`.

## Otvorene stavke

Tablica, slika (privitak, obrezivanje) i naslovnica iz dokumenta čekaju validator SRV-10A 2/2; PDF i pregled ispisa čekaju font iz SRV-9C; navodi, fusnote i unakrsne poveznice u izvozu; ruta i ugovor `/api/v1`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md): `domain` kroz `index.ts`.

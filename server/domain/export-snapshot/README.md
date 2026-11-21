# server/domain/export-snapshot

Dio domene izvoza prema [karti servera](../../../docs/server-map.md) i planu M8.0-S2 i M8.4-P01.

## Što radi

`freezeExportSnapshot` odvojeno kopira i duboko zamrzava odabranu reviziju V4, vrstu revizije, postavke stranice, naslovnicu i rok. `canonicalJson` je JCS zapis tih podataka, identifikatora revizije i karte sposobnosti. `sha256` je heksadekadski SHA-256 tog zapisa u UTF-8.

Karta obuhvaća sve vrste čvorova V4 prema mogućnostima postojećeg DOCX pisca. Formule se ispisuju kao TeX, natuknice kao tekstualne oznake, a okviri i kod u pojednostavljenom obliku (`degraded`). Tablice, slike, navodi, fusnote, unakrsne poveznice i nepoznate vrste čvorova označene su kao `omitted`. Svi čvorovi ostaju u dokumentu snapshota.

## Tko ga zove

Pozivatelj koji je odabrao spremljenu (`saved`) ili predanu (`submitted`) reviziju predaje njezin dokument i identifikator te zadaje `expiresAt` kao ISO 8601 niz u UTC-u. Pozivatelj utvrđuje je li artefakt istekao.

## Koje podatke dira

Samo predani JSON. Preuzimanje revizije, spajanje naslovnice s podacima ustanove, provedba roka, povezivanje s DOCX piscem i manifest D-173 pripadaju pozivateljima.

## Što izvozi

`freezeExportSnapshot`, `ExportSnapshot` i pripadne tipove kroz `index.ts`.

## Što ne smije uvoziti

Druga poslužiteljska područja prema [karti servera](../../../docs/server-map.md).

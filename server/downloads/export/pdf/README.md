# server/downloads/export/pdf

## Što radi

Pretvara DOCX izrađen iz zamrznutog `ExportSnapshot` u PDF. Oznaku PDF/A-2u i hash izvješća izdaje samo kad veraPDF za točne izlazne bajtove potvrdi profil 2u. U ostalim slučajevima pretvara isti DOCX u obični PDF.

## Tko ga zove

HTTP adapter izvoza i provjera jednakosti u CI-ju. Pozivatelj provjerava ovlasti i odabire reviziju prije izvoza.

## Koje podatke dira

LibreOffice dobiva samo izrađeni DOCX. U CI-ju pretvorba radi u jednokratnom kontejneru bez mreže i pristupa datotekama domaćina. veraPDF radi u CI-ju nad izmišljenim dokumentima.

## Što izvozi

`createSnapshotPdf` i `localPdfConverter`; za slajdove `renderSlidesExport`, `slidesBodyKind` i `localSlidesPdfConverter` (SRV-V13-RUTA-IZVOZ): `.pptx` iz `../pptx.ts` ili PDF pretvoren iz točno tog `.pptx` istim lokalnim Gotenbergom, uvijek običan PDF (bez oznake PDF/A, jer za slajdove nema veraPDF potvrde), a nedostupan pretvarač, istek i neuspjeh pretvorbe su zasebna stanja. Poslužitelj koristi samo Gotenberg na lokalnoj povratnoj adresi. Domaćin pretvorbe treba pinanu sliku iz SRV-1805 i odvojenu konfiguraciju koja izolira LibreOffice i zabranjuje izlazni mrežni promet.

## Što ne smije uvoziti

Vrijede rubovi područja preuzimanja iz [karte servera](../../../../docs/server-map.md).

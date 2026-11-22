# server/downloads/interview-pdf

Generator PDF-a pripreme za razgovor (SRV-1531, N-14) u području [preuzimanja](../README.md).

## Što radi

Iz pripreme rada koju vidi student nakon poziva izrađuje A4 dokument od jedne ili više stranica: natpis „Ovo je priprema za razgovor, ne optužba ni disciplinski postupak.”, termin, datum održanog razgovora, pitanja i objašnjenja studenta. Nema polja za ishod, ocjenu, sankciju ni sumnju. Isti ulaz i natpisi daju iste bajtove.

## Tko ga zove

Poslužiteljski adapter `server/http/work-interview/pdf` koji je prethodno pročitao pripremu kroz bazu, pa je pristup već provjeren.

## Koje podatke dira

Čita dobivenu pripremu i hrvatske natpise iz kataloga. Znakove kojih ugrađeni font nema ispisuje kao obične (navodnici, crtice) ili kao „?”. PDF nema metapodatke o trenutku preuzimanja.

## Što izvozi

`renderInterviewPdf` vraća PDF kao `Uint8Array`. Font je podskup iz [receipt-pdf](../receipt-pdf/README.md).

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../docs/server-map.md). Generator ne otvara bazu i ne poziva mrežu.

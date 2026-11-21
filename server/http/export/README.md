# server/http/export

## Što radi

`GET /api/v1/assignments/{assignmentId}/works/{documentId}/export/pdf` iz predane ili zadnje objavljene revizije sastavlja privatni izvoz, s otiskom PDF-a. Obični PDF uključuje pripadni DOCX i ključ hrvatske obavijesti o formatu.

## Tko ga zove

Vlasnik rada ili aktivni mentor rada. U istoj naredbi postojeći RPC-i utvrđuju pripadnost dokumenta zadatku i ovlast, zatim čitaju predanu ili zadnju objavljenu reviziju. Mentorovo čitanje koristi postojeći zapis pristupa.

## Koje podatke dira

U memoriji drži reviziju dokumenta, podatke naslovnice i datoteke izvoza. Naslovnica koristi naziv ustanove, naziv zadatka, dostupno ime studenta i autorska polja dokumenta. Format je postojeći A4 profil DOCX pisca.

## Što izvozi

`createWorkPdfRouteFor`. `DUCTURA_PDF_RENDERER_ORIGIN` određuje lokalni, izolirani pretvornik. U njegovoj odsutnosti ovlašten zahtjev dobiva 503. D-253 ograničava veraPDF na CI, pa izravan HTTP izvoz vraća obični PDF.

## Što ne smije uvoziti

Vrijede rubovi za HTTP iz [karte servera](../../../docs/server-map.md).

# server/http/export

## Što radi

`GET /api/v1/assignments/{assignmentId}/works/{documentId}/export/pdf` iz predane ili zadnje objavljene revizije sastavlja privatni izvoz, s otiskom PDF-a. Obični PDF uključuje pripadni DOCX i ključ hrvatske obavijesti o formatu.

`POST /api/v1/student/submissions/{submissionId}/package-link` i `GET .../package/{kind}` (`submission-package.ts`, SRV-1807): vlasnik predaje traži poveznicu od 24 sata na izvozni paket (`package`) ili na potvrdu za referadu (`referada`, PDF bez teksta rada) i preuzima kroz nju. Poveznica je vezana uz sesiju koja ju je tražila; tuđa predaja, nepoznata, kriva vrsta ili kriva poveznica daju isti 404, istekla 410. PDF potvrde nosi vezani kod potvrde, pročitan pod istom sesijom kao u `student.receipt-pdf.get` i samo dok je ta predaja živa predaja zadatka. Povučena predaja i predaja studenta koji više nije u kolegiju dobivaju PDF bez koda, kao prije Dizajna 1.1. Neuspjelo čitanje daje 503 (`server/http/submission-confirmation-code.ts`).

## Tko ga zove

Vlasnik rada ili aktivni mentor rada. U istoj naredbi postojeći RPC-i utvrđuju pripadnost dokumenta zadatku i ovlast, zatim čitaju predanu ili zadnju objavljenu reviziju. Mentorovo čitanje koristi postojeći zapis pristupa.

## Koje podatke dira

U memoriji drži reviziju dokumenta, podatke naslovnice i datoteke izvoza. Naslovnica koristi naziv ustanove, naziv zadatka, dostupno ime studenta i autorska polja dokumenta. Format je postojeći A4 profil DOCX pisca.

## Što izvozi

`createWorkPdfRouteFor`, `createSubmissionPackageRoutes`, `createSubmissionPackageRoutesFor`. `DUCTURA_PDF_RENDERER_ORIGIN` određuje lokalni, izolirani pretvornik. U njegovoj odsutnosti ovlašten zahtjev dobiva 503. D-253 ograničava veraPDF na CI, pa izravan HTTP izvoz vraća obični PDF.

## Što ne smije uvoziti

Vrijede rubovi za HTTP iz [karte servera](../../../docs/server-map.md).

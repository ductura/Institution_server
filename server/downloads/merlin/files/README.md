# server/downloads/merlin/files

Datoteke predanog rada u paketu za Merlin (SRV-1109, Val 11, N-18, C-16) u području [preuzimanja](../../README.md).

## Što radi

`renderWorkFiles` iz dokumenta predane revizije izrađuje DOCX (izvoz iz `../../export`) i PDF s istim blokovima (ugrađeni podskup Noto Sans iz `../../receipt-pdf`; znak bez glifa ispisuje se kao „?”). Isti dokument, ime i natpisi daju iste bajtove, pa je otisak na popisu otisak datoteke u paketu. Dokument v1 do v3 ima samo blokove i tekst koje izvoz v4 čita jednako; navodi, fusnote i unakrsne poveznice ne ispisuju znakove, kao u izvozu v4.

`fileBaseName` daje ASCII naziv `prezime-ime-<8 heksadecimalnih znamenki oznake studenta>` (hrvatska slova se preslikavaju, sve ostalo postaje „-”); bez para imena `student-<…>`. `sha256Hex` je otisak bajtova.

`createSubmittedWorksReader` čita `app.fast_path_works` pod `withActor` (migracija 20261027200000): baza odlučuje tko dobiva retke (nastavnik zadatka, C-23), daje par imena i tekst kontrolne točke na reviziji koju drži prozor nastavnika (za predan rad predana revizija) i u istoj transakciji upisuje otvaranje svakog teksta u dnevnik pristupa. Redak koji čitač ne može potvrditi baca.

## Tko ga zove

`../roster` i `server/http/merlin-roster` (koji mu predaje `withActor`).

## Koje podatke dira

Čitač čita bazu kroz predani `withActor`; funkcije izrade samo svoj ulaz.

## Što izvozi

`renderWorkFiles`, `renderWorkPdf`, `exportModelOf`, `fileBaseName`, `sha256Hex`, `createSubmittedWorksReader`, `sourceOf` i tipove iz `index.ts`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../../docs/server-map.md): `domain`, `database` samo s `import type`.

## Otvorene stavke

Otvaranje se u dnevnik pristupa upisuje s površinom `fast_path`; zasebna površina za izvoz traži migraciju (traka S-B). Prozor P-03 brzog puta drži reviziju 5 minuta: predaja nakon otvaranja prozora daje 503 dok prozor ne istekne.

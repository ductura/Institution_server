# server/downloads/merlin/packages

Paket za Merlin (SRV-1110, Val 11, N-18, C-16, D4) u području [preuzimanja](../../README.md).

## Što radi

`buildMerlinPackageZip` od popisa iz `../roster` slaže ZIP (pisač ZIP-a iz `../../export`: nesažeti unosi, fiksno vrijeme, pa isti popis daje iste bajtove): `merlin-popis.csv` (isti bajtovi kao `teacher.merlin-roster-csv.get`), PDF i DOCX svakog predanog rada pod nazivima s popisa i `otisci.sha256` (redak po datoteci: SHA-256, dva razmaka, naziv). Prije pisanja provjerava da je svaki otisak s popisa otisak datoteke koju ZIP nosi i da ZIP ne nosi datoteku koju popis ne imenuje; ako se ne slažu, baca. Tako CSV, `otisci.sha256` i datoteke dolaze iz istog skupa bajtova.

`createMerlinPackageService` vodi zahtjev: port baze (`server/database/merlin-packages`) traži paket po ključu zahtjeva; isti ključ je isti paket. Paket koji je zahtjev preuzeo (nov ili neuspio) gradi se u istom zahtjevu, pod sesijom pozivatelja: popis, ZIP, pa spremanje (baza računa otisak, a port ga uspoređuje s otiskom ZIP-a prije commita). Gradnja koja baci zapisuje se kao neuspjela sa zatvorenim kodom (`build_failed`, `roster_refused`) i prijavljuje; isti ključ je gradi ponovno. Stanje i preuzimanje idu ravno u port: pristup (samo nastavnik koji je tražio, dok predaje rad), rok od 24 sata i zapis svakog preuzimanja određuje baza.

## Tko ga zove

`server/http/merlin-packages`.

## Koje podatke dira

Samo ulaz funkcija i portove koje mu preda adapter. Ne otvara bazu ni pohranu sam.

## Što izvozi

`buildMerlinPackageZip`, `createMerlinPackageService`, `MERLIN_PACKAGE_CSV`, `MERLIN_PACKAGE_FINGERPRINTS` i tipove iz `index.ts`.

## Što ne smije uvoziti

Vrijede rubovi iz [karte servera](../../../../docs/server-map.md): `domain`, `database` samo s `import type`.

## Otvorene stavke

- Gradnja je u zahtjevu dok ne postoji worker (VS-1b dio 2/3); stanja su ona koja bi worker koristio, pa premještanje ne mijenja ugovor. Paket koji graditelj nije dovršio može se preuzeti ponovno nakon deset minuta.
- ZIP je u bazi (`bytea`, najviše 64 MiB), ne u pohrani objekata: pohrana u repou je samo za dokaze. Brisanje isteklih paketa čeka posao čuvanja.
- Popis razloga produljenja (C-16) nije zasebna datoteka u paketu: natpisi bi tražili nove tekstove u `locales/merlin.ts` (SRV-1109); razlozi su u JSON-u `teacher.merlin-roster.get`.

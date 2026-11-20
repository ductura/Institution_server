# Verzije rada

Port popisa verzija jednog rada (SRV-9A, Ductus#2028): spremljene točke dokumenta i predaja, najnovije prvo, stranicu po stranicu. Popis je ulaz za usporedbu i reprodukciju (Ductus `docs/PRODUCT.md` §5 pravilo 7, N-11 u `docs/design/ductura/m7-reference-b`); student rada i nastavnik zadatka dobivaju isti popis (pravilo 5).

## Što radi

`createWorkVersionsReader(withActor)` daje čitača `(token, documentId, beforeRevision)` koji u jednoj transakciji poziva `app.read_work_versions($1, $2::bigint)`:

- pristup odlučuje baza istim odnosom kao reprodukcija (`collaboration.document_scope` i `collaboration.actor_role`): vlasnik rada ili nastavnik zadatka; svako odbijanje i nepostojeći rad su jedan redak `not_found` (C-23);
- čitanje nastavnika upisuje redak dnevnika pristupa u istoj transakciji;
- verzija je `checkpoint` ili `submission`, s revizijom i vremenom na cijelu minutu (D-24); predaja još nosi je li došla nakon roka. Nema teksta, hasha, id-a predaje ni točnog vremena;
- spremljene točke presječene su predanom revizijom kao u reprodukciji;
- stranica ima najviše `WORK_VERSIONS_PAGE_SIZE` (200) verzija; funkcija vraća jedan redak više kad ih ima još, a stranica tada završava prije revizije tog retka, pa se revizija nikad ne dijeli na dvije stranice. `nextBeforeRevision` je kursor sljedeće stranice;
- rad bez ijedne verzije je jedan redak `empty`.

Ishodi su vrijednosti, ne iznimke: ZD401 `unauthenticated`, kursor koji nije `null` ni cijeli broj od barem 2 `invalid_input` (prije baze), redak koji port ne može potvrditi `unavailable` za cijelu stranicu; sve ostalo se baca. Testovi: `work-versions.test.ts`.

## Ovisnost

Funkciju `app.read_work_versions` piše traka migracija (S-B); prijedlog potpisa je na Ductus#2028 (c.7041207655). Dok je nema, poziv baca grešku baze, a ruta odgovara 503.

## Tko ga zove

Ruta popisa verzija (`server/evidence/versions/`, sljedeći korak) preko `server/database/index.ts`.

## Koje podatke dira

Ništa izravno: samo `app.read_work_versions` glavne baze. Korisnik i ustanova dolaze samo iz sesije.

## Što izvozi

`createWorkVersionsReader`, `pageOf`, `versionOf`, `WORK_VERSIONS_PAGE_SIZE` i tipove `WorkVersionsItem`, `WorkVersionsPage`, `WorkVersionsReader`.

## Što ne smije uvoziti

Ništa osim tipa `WithActor` iz `server/database` (karta servera).

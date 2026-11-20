# Izvori rada

Port popisa izvora rada studenta (SRV-7B; migracije `20261120180000_work_source.sql` i `20261120190000_work_source_teacher.sql`). Popis je bilježnica izvora (D-59) s istim zapisom izvora kao `sources[]` u dokumentu (D-226, Ductus `docs/contracts/document-schema-v2.md` §2), a uz zapis nosi ono što ugovor v3 stavlja u tablicu: DOI, ISBN, „b. g.” i oznaku preporučen ili obvezan (`docs/contracts/document-schema-v3.md`, „Izbor ugovora”).

## Što radi

`createWorkSources(withActor)` daje pet poziva, svaki u jednoj transakciji kroz RPC, nikad izravno u tablicu:

- `list(token, assignmentId, studentId)`: popis jednog rada redom upisa; `studentId` prazan za vlastiti rad, inače rad studenta kojemu je pozivatelj nastavnik (nositelj ili suradnik kolegija, nastavnik grupe, mentor);
- `save(token, input)`: student rada dodaje ili mijenja svoj izvor (isti `id` zapisa);
- `saveForStudent(token, input)`: nastavnik rada dodaje ili mijenja preporučen ili obvezan izvor u radu studenta;
- `remove` i `removeForStudent`: brisanje, svaka strana samo svojih izvora.

Zapis se provjerava cijelim `validateSources` prije baze; DOI mora biti malim slovima, a ISBN samo znamenke s ispravnom kontrolnom znamenkom (`isWorkSourceDoi`, `isWorkSourceIsbn`). Ishodi su vrijednosti, ne iznimke: ZD401 `unauthorized`, ZD403 `not_found` (jedan odgovor za svako odbijanje, C-23), ZD422 `invalid_input`; sve ostalo se baca. Spremljeni redak potvrđuje se unutar transakcije, pa pogrešan odgovor poništava upis. Testovi: `work-sources.test.ts`; ovlasti i oblik u bazi pokrivaju `db/main/tests/149-work-source.sql` i `150-work-source-teacher.sql`.

## Tko ga zove

Ruta izvora rada (sljedeći korak, traka ugovora) preko `server/database/index.ts`.

## Koje podatke dira

Tablicu `institution.work_source` glavne baze, samo kroz `institution.work_sources`, `save_work_source`, `delete_work_source`, `save_teacher_work_source` i `delete_teacher_work_source`. Student i ustanova dolaze samo iz sesije.

## Što izvozi

`createWorkSources`, `isWorkSourceDoi`, `isWorkSourceIsbn` i tipove `WorkSource`, `WorkSourceInput`, `WorkSourceList`, `WorkSourceSave`, `WorkSourceRemove`, `WorkSourceRequirement`, `WorkSources`.

## Što ne smije uvoziti

Ništa osim `domain` i tipa `WithActor` iz `server/database` (karta servera).

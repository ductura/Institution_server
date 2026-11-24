# Rubrika zadatka (SRV-V17-RUBRIC-DEF)

`createAssignmentRubric(withActor)` je port baze za rubriku zadatka: 1 do 12 kriterija `{id, title, levels}`, svaki s točno tri razine `{label, descriptor}` od najniže do najviše, bez broja, težine, zbroja ili ocjene.

- Verzionirano samo dodavanjem (`institution.assignment_rubric_version`, svaka uloga: izmjena i brisanje su `ZD409`). Nastavnik zadatka zamjenjuje rubriku novom verzijom uz `expectedVersion` (`app.publish_assignment_rubric`); druga verzija u međuvremenu je `ZD409`.
- Čita je nastavnik zadatka (`read_assignment_rubric_teacher`: verzija 0 i prazan popis dok je nema) i student zadatka (`read_assignment_rubric_student`: dok je nema, port vraća zadanih šest radnih kriterija, verzija 0, s ključevima poruka `workingCriteria.<id>` i `assignmentRubric.level*` umjesto rečenica).
- Pristup iz odnosa (C-23): otvoreni član predmeta s ulogom nastavnika (potvrđena, neopozvana) ili mentor otvorenog mentorstva; student je otvoreni član predmeta ili student otvorenog mentorstva. Tuđi, nepoznat i iz druge ustanove: isti `ZD404`.
- Odvojeno od privatnih radnih kriterija mentora (SRV-1107), koje student ne čita.

PgTAP: `db/main/tests/247-assignment-rubric.sql` i redci u `030-institution-access-matrix.sql`.

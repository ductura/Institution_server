# Rubrika zadatka, HTTP rub (SRV-V17-RUBRIC-DEF)

`createAssignmentRubricRoutesFor(main)` montira tri rute iz `server/contracts/routes/assignment-rubric.ts`: `teacher.assignment-rubric.get` i `.put` (`/api/v1/teacher/assignments/{assignmentId}/rubric`) i `student.assignment-rubric.get` (`/api/v1/student/assignments/{assignmentId}/rubric`).

- Tko smije odlučuje baza (nastavnik zadatka piše i čita, student zadatka čita). Ustanova i autor dolaze iz sjednice, nikad iz tijela. Student, nastavnik drugog predmeta, druga ustanova, nepoznat i neispravan `assignmentId` dobivaju isti 404.
- Tijelo PUT-a je točno `{expectedVersion, criteria}`; izvan ugovora je 422, zastarjeli `expectedVersion` je 409.
- Odgovor izvan ugovora ili iznimka je 503, a iznimka se prijavljuje.
- Port baze: `server/database/assignment-rubric`.

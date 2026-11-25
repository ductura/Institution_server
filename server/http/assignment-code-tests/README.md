# Testovi koda uz zadatak, HTTP rub (SRV-V21-KOD-TESTOVI-RUTA)

`createAssignmentCodeTestsRoutesFor(main)` montira tri rute iz `server/contracts/routes/assignment-code-tests.ts`: `teacher.assignment-code-tests.get` i `.put` (`/api/v1/teacher/assignments/{assignmentId}/code-tests`) i `student.assignment-code-tests.get` (`/api/v1/student/assignments/{assignmentId}/code-tests`).

- Tko smije odlučuje baza: nastavnik zadatka piše, a nastavnik i student zadatka čitaju. Čitanje nije razdvojeno po ulozi, pa obje GET rute vraćaju istu zadnju reviziju (testovi su vidljivi studentu). Ustanova i autor dolaze iz sjednice, nikad iz tijela.
- Student zadatka koji piše dobiva 403 `forbidden`. Nastavnik drugog predmeta, druga ustanova, mentorski zadatak, nepoznat i neispravan `assignmentId` dobivaju isti 404.
- Tijelo PUT-a je točno `{language, tests}`, najviše 16 KiB (veće je 413). Više od 10 testova, ponovljeni `id` i testovi koje baza nađe većima od 16 KiB daju 422 `invalid_code_tests`; svaki drugi oblik izvan ugovora daje 422 `invalid_input`.
- Dok testova nema, odgovor je `{revisionNo: 0, language: "javascript", tests: []}`.
- Poslužitelj nikad ne pokreće studentski kod i ne prima rezultat pokretanja.
- Odgovor izvan ugovora ili iznimka je 503, a iznimka se prijavljuje.
- Port baze: `server/database/assignment-code-tests`.

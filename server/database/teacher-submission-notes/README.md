# Napomene studenta za nastavnika

`createTeacherSubmissionNotesReader` poziva `app.submission_notes(zadatak, student)` i vraća napomene koje je student zapisao uz predaju, najstarije prve. Pristup provjerava baza prema odnosu čitatelja sa studentovim radom (nastavnik kolegija, nastavnik seminarske grupe, mentor); odbijen pristup i nepostojeći zadatak ili student izgledaju jednako (`not_found`). Čitanje ne piše u dnevnik pristupa.

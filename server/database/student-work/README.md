# Rad studenta

SRV-1412 (plan M2.1 do M2.3): student započinje svoj rad na zadatku i čita svoje radove („Moji radovi”).

- `createStudentWorkStarter`: u jednoj transakciji `app.open_student_work(zadatak, true)` (rad nastaje najviše jednom po studentu i zadatku; jedinstveni ključ odlučuje i kod istodobnog starta), zatim verzija pravila ustanove na koju je zadatak vezan (`app.assignment_institution_config`, `null` za zadatak bez verzije) i jezik rada (`institution.work_language`). Zadatak tuđeg kolegija i nepostojeći zadatak su `not_found`.
- `createStudentWorksReader`: jedan upit nad `app.student_workspace()` sa studentovim rokom (`app.student_effective_due_at`), stanjem predaje (`app.my_submission_state`) i jezikom rada. Čita samo pozivateljev rad; ništa od nastavnika (ocjena, bilješka, prilagodba, mjerila) ni druge osobe.

Nova tablica ni RPC nisu dodani; sve funkcije već imaju RLS, `GRANT` i retke u pgTAP matrici. Redak koji upit ne vraća u tom obliku baca `StudentWorkRowError`, pa transakcija ide natrag, a ruta odgovara 503.

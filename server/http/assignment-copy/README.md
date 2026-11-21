# HTTP za kopiranje zadatka

`POST /api/v1/teacher/assignments/{assignmentId}/copy` (SRV-1904, P-D4): nastavnik zadatka kopira ga u kolegij koji predaje. Tijelo je `{requestKey, courseId}` i po želji novi `opensAt` i `dueAt`. Odgovor 201 nosi id kopije i `versionNo: 1`; izvor se ne mijenja, a predaje i retci o studentima se ne kopiraju.

Zadatak ili kolegij bez pristupa, nepoznat i neispravan id daju isti 404 (C-23). Pravila su u bazi (`institution.copy_assignment`); ovdje je samo HTTP rub. Testovi prolaze kroz rukovatelj s dvojnikom porta, a PostgreSQL test kroz stvarnu bazu.

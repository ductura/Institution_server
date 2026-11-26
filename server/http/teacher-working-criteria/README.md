# server/http/teacher-working-criteria

Rute `GET /api/v1/teacher/works/{documentId}/working-criteria` i `PUT .../working-criteria/{criterionId}` (SRV-1107, B-9, Ductus#2051). Šest kriterija ocjene je samo radna bilješka nastavnika (D-130): čita je i piše samo nastavnik rada koji ju je upisao.

- `GET` vraća `{criteria: [{id, label, assessment, note}]}` (`label` je ključ poruke `workingCriteria.<id>`, tekst je u `locales/hr.json`), uvijek svih šest istim redom; neupisano je `null`.
- `PUT` prima `{assessment, note}` i zamjenjuje oba: `null` briše procjenu ili bilješku. Procjena je 0, 1 ili 2 (treba doraditi, dobro, vrlo dobro), bez bodova. Vraća spremljeni kriterij.
- Student, drugi nastavnik, nepoznat rad i nepoznat kriterij dobivaju isti 404; nevaljana sesija 401; nevaljano tijelo 422.
- `GET /api/v1/student/works/{documentId}/working-criteria` (SRV-ED35, Danielova odluka od 26. 11. 2026., Ductus#2058 c.7192734757, zamjenjuje B-9) daje studentu vlasniku rada kriterije svakog nastavnika zasebno, nikad spojene: `{teachers: [{teacherId, teacherName, criteria}]}`, s istih šest kriterija kao `GET` za nastavnika. Nastavnici bez ijednog upisa se ne prikazuju. `teacherName` je `null` kad ustanova nema ime. Svi ostali dobivaju isti 404. Student ništa ne piše.
- Osim te rute, kriterija nema ni u jednom studentskom odgovoru ni izvozu. To čuvaju pgTAP i test `teacher-working-criteria.integration.test.ts`.
- Čitanje i pisanje ne dira dokument, hash lanac ni dnevnik pristupa.

# server/http/teacher-working-criteria

Rute `GET /api/v1/teacher/works/{documentId}/working-criteria` i `PUT .../working-criteria/{criterionId}` (SRV-1107, B-9, Ductus#2051). Šest kriterija ocjene je samo radna bilješka nastavnika (D-130): čita je i piše samo nastavnik rada koji ju je upisao.

- `GET` vraća `{criteria: [{id, label, assessment, note}]}` (`label` je ključ poruke `workingCriteria.<id>`, tekst je u `locales/hr.json`), uvijek svih šest istim redom; neupisano je `null`.
- `PUT` prima `{assessment, note}` i zamjenjuje oba: `null` briše procjenu ili bilješku. Procjena je 0, 1 ili 2 (treba doraditi, dobro, vrlo dobro), bez bodova. Vraća spremljeni kriterij.
- Student, drugi nastavnik, nepoznat rad i nepoznat kriterij dobivaju isti 404; nevaljana sesija 401; nevaljano tijelo 422.
- Kriterija nema ni u jednom studentskom odgovoru ni izvozu; to čuvaju pgTAP (nema grantova za studenta) i test `teacher-working-criteria.integration.test.ts`.
- Čitanje i pisanje ne dira dokument, hash lanac ni dnevnik pristupa.

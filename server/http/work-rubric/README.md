# server/http/work-rubric

Rute `GET /api/v1/teacher/works/{documentId}/rubric` i `PUT .../rubric/{criterionId}` (SRV-V17-RUBRIC-LEVEL, Ductus#2055). Nastavnikova oznaka razine po kriteriju rubrike zadatka na radu: čita je i piše samo nastavnik rada koji ju je upisao.

- `GET` vraća `{rubricVersion, marks: [{criterionId, level, note}]}` za zadnju verziju rubrike, redom kriterija; neupisano je `null`. Bez rubrike je verzija 0 i zadanih šest kriterija.
- `PUT` prima `{level, note}` i zamjenjuje oba: `null` za oba briše oznaku. Razina je 0, 1 ili 2, bez bodova. Vraća spremljenu oznaku.
- Student, drugi nastavnik, nepoznat rad i kriterij izvan zadnje verzije dobivaju isti 404; nevaljana sesija 401; nevaljano tijelo 422.
- Oznake nema ni u jednom studentskom odgovoru ni izvozu; to čuvaju pgTAP (nema grantova za studenta) i integracijski test.
- Čitanje i pisanje ne dira dokument, hash lanac ni dnevnik pristupa.

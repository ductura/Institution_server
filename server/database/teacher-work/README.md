# server/database/teacher-work

Priključak baze za nastavnikovo čitanje jednog rada po `documentId` (SRV-2003, Ductus#2028 c.7024185874). Jedna `withActor` transakcija nad jednim RPC-om `app.teacher_work_get`.

- Rad čita samo onaj koji smije čitati rad tog studenta (nastavnik ili suradnik kolegija, nastavnik grupe za vlastitu grupu, mentor). Student, drugi nastavnik i nepoznat rad dobivaju isti `not_found`.
- Odgovor je zatvoren status, nikad poruka ni SQLSTATE baze. Redak neočekivanog oblika je `unavailable`.
- Stanje: `nije_predano`, `nakon_roka`, `ceka` (predano, potvrda još nije vezana) i `predano`.
- Susjedni radovi su iz istog zadatka među radovima koje pozivatelj smije čitati, istim redom kao pregled zadatka.
- Nema teksta rada, hasha ni id-a predaje; ništa se ne piše, pa ni u dnevnik pristupa.

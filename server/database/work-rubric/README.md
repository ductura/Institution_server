# server/database/work-rubric

Priključak baze za nastavnikovu oznaku razine po kriteriju rubrike zadatka na radu (SRV-V17-RUBRIC-LEVEL): `collaboration.list_work_rubric` i `save_work_rubric_mark`. Svaki poziv je jedna `withActor` transakcija nad jednim RPC-om.

- Čita i piše samo nastavnik rada koji je autor; student, drugi nastavnik, nepoznat rad i kriterij izvan zadnje verzije rubrike dobivaju isti `not_found`.
- Oznaka je razina 0, 1 ili 2 (položaj razine u kriteriju) ili `null`, uz kratku bilješku; iz nje se ništa ne računa.
- Oznaka je vezana uz verziju rubrike; dok nastavnik nije postavio rubriku, verzija je 0 i kriteriji su zadanih šest.
- Odgovor je zatvoren status, nikad poruka ni SQLSTATE baze. Redak neočekivanog oblika je `unavailable`.

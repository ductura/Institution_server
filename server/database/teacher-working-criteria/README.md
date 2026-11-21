# server/database/teacher-working-criteria

Priključak baze za nastavnikove privatne radne kriterije (SRV-1107, B-9): šest kriterija ocjene rada kao radna bilješka nastavnika. Svaki poziv je jedna `withActor` transakcija nad jednim RPC-om sheme `collaboration` (`list_working_criteria`, `save_working_criterion`).

- Čita i piše samo nastavnik rada koji je autor; student, drugi nastavnik i nepoznat rad dobivaju isti `not_found`.
- Odgovor je zatvoren status, nikad poruka ni SQLSTATE baze. Redak neočekivanog oblika je `unavailable`.
- Procjena je oznaka 0, 1 ili 2 (treba doraditi, dobro, vrlo dobro), nikad bodovi; iz nje se ništa ne računa.
- Popis uvijek ima svih šest kriterija istim redom; oznake su iz prototipa (`WORKING_CRITERIA`).
- Ništa ne dira dokument, hash lanac ni dnevnik pristupa.

# server/database/work-team

Adapter timova na zadatku (val 19, SRV-V19-GRUPA-RUTE): `createWorkTeamStore(withActor, source?)`. Svaki poziv je jedna `withActor` transakcija s `app.*` RPC-ima iz migracije `20261219310000` (`set_assignment_team_setting`, `assignment_team_setting`, `team_action`, `student_team`, `teacher_teams`, `teacher_create_team`, `teacher_team_member`); klijent nikad ne piše izravno u tablice. Poredak ljudi je domenski (prezime, ime, id) i primjenjuje se ponovno ovdje, neovisno o kolaciji baze.

Doprinos: zapisi po članu (SRV-1222) nisu na ovoj bazi, pa je zadani izvor isključen i obje rute doprinosa vraćaju `disabled` (provenance-share-v1 §8). Kad SRV-1222 stigne, njegov čitač se predaje kao `ContributionSource.readParts`; sastavljanje odgovora ostaje u `server/domain/work-team`.

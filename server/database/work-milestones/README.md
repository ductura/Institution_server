# Etape rada

`createWorkMilestones(withActor)` čita etape konfigurirane za zadatak i prenosi izmjenu roka jedne etape na bazu. Baza određuje ovlasti prema dokumentu iz putanje i sesiji pozivatelja. Rok promijenjen na jednom radu ostaje vezan uz taj dokument.

Definicije etapa upisuju se u `institution.work_milestone` pri konfiguriranju tijeka rada za zadatak. Bez konfiguracije popis je prazan. Rok iz definicije je izboran. Čitanje koristi rok dokumenta iz `institution.work_milestone_deadline` kad postoji. Jedina izmjena iz API-ja upisuje taj rok. RPC sinkronizira izmjenu s konačnom predajom putem zaključavanja dokumenta.

HTTP integracijski test pokriva oba poziva s adapterom. PgTAP test `161-work-milestone-access.sql` pokriva bazu.

## Stanja etapa (SRV-1520)

Migracija `20261213100000_milestone_states.sql` dodaje `institution.work_milestone_progress` (stanje po radu i etapi; nema retka dok etapa nije poslana) i `institution.work_milestone_event` (samo dodavanje: slanje, zatražena dorada, odobrenje, s akterom i revizijom). RPC-ovi: `read_work_milestone_states`, `submit_work_milestone`, `request_work_milestone_revision`, `approve_work_milestone`, `change_work_milestone`, `delete_work_milestone`. Slanje piše student vlasnik, dorada i odobrenje mentor (odnos, C-23); nastavnik tečaja nije mentor (403). PgTAP: `220-milestone-states.sql` i redci u `030-institution-access-matrix.sql`.

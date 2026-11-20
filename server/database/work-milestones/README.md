# Etape rada

`createWorkMilestones(withActor)` čita etape konfigurirane za zadatak i prenosi izmjenu roka jedne etape na bazu. Baza određuje ovlasti prema dokumentu iz putanje i sesiji pozivatelja. Rok promijenjen na jednom radu ostaje vezan uz taj dokument.

Definicije etapa upisuju se u `institution.work_milestone` pri konfiguriranju tijeka rada za zadatak. Bez konfiguracije popis je prazan. Rok iz definicije je izboran. Čitanje koristi rok dokumenta iz `institution.work_milestone_deadline` kad postoji. Jedina izmjena iz API-ja upisuje taj rok. RPC sinkronizira izmjenu s konačnom predajom putem zaključavanja dokumenta.

HTTP integracijski test pokriva oba poziva s adapterom. PgTAP test `161-work-milestone-access.sql` pokriva bazu.

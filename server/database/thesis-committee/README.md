# Povjerenstvo završnog ili diplomskog rada: popis uz rad

`createThesisCommitteeStore` (SRV-V16-POVJERENSTVO-ZAPIS) čita i piše samo kroz RPC-e `app.*` iz migracije `20261220130000_thesis_committee.sql`: članovi povjerenstva (predsjednik, članovi) i vrijeme zadnje promjene. Čitaju student vlasnik, mentor i administrator fakulteta, a piše samo administrator; cijeli se popis zamjenjuje, a svaka promjena je zapis samo za dodavanje. Popis ne daje pravo čitanja rada i ne dira `institution.work_grant`.

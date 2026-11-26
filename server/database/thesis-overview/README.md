# Popis završnih i diplomskih radova fakulteta

`createThesisOverviewStore` (SRV-V16-POPIS-FAKULTET) čita samo kroz RPC `app.read_thesis_overview` iz migracije `20261220140000_thesis_overview.sql`: vrsta rada, mentor, student, stanje nakon predaje, datum obrane, stanje teme i veličina povjerenstva za radove fakulteta administratora. Samo čitanje; poredak je datum obrane (radovi bez datuma na kraju), pa ID mentorstva, bez rangiranja. Stranice idu po ključu posljednjeg retka (`next`), pa nijedan rad nije preskočen ni ponovljen.

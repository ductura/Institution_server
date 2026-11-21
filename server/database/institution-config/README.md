# Konfiguracija ustanove

Datoteke `config/faculties/<kod>.json` formata `ductura-institution-config-v1` nose verziju i pravila o profilu evidencije i dopuštenju uvoza. Pokretanje provjerava datoteke iz radne mape, uključujući postojeći AI format. Samostalni paket bez te mape koristi objavljene verzije iz baze.

Ako `<kod>.json` već sadrži AI postavke, pravila ustanove idu u `<kod>.rules.json`. Ustanova smije imati jednu datoteku pravila.

Iz korijena repozitorija `node config/faculties/publication-sql.ts demo-pravila` ispisuje SQL za pregled i primjenu u lokalnoj ili testnoj bazi. Operater ga izvršava nakon što izmišljena ustanova s tim kodom postoji u `identity.institution`. Nova verzija mora biti viša od objavljene. Ponovna objava identične verzije je sigurna. Primjer ne dodaje ustanovu niti objavljuje pravila pri pokretanju.

Izrada zadatka veže najvišu objavljenu verziju njegove ustanove. Interni čitač `app.assignment_institution_config(uuid)` vraća vezanu verziju i pravila akteru s pristupom zadatku. Zadatak bez prethodno objavljene konfiguracije nema vezanu verziju. Zasebna pravila po vrsti rada i postojeće provjere pristupa zadržavaju svoje izvore.

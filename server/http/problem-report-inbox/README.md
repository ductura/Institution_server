# HTTP za prijave problema po primatelju

`GET /api/v1/problem-reports` (SRV-ADMIN-1, NF-7 OA-7) daje pozivatelju prijave koje su njemu usmjerene, najnovije prve, najviše 500 (`truncated` kaže da ih ima još): tehničke mrežnom inženjeru ustanove, prijave o računu i ulogama te prijave o kolegiju bez navedenog kolegija potvrđenom administratoru, prijave o kolegiju nastavničkom timu tog kolegija. Svaka nosi ono što je pošiljatelj upisao, zatvoreni tehnički kontekst i stanje, a nikad tko ju je poslao. Račun koji nije ništa od toga dobiva 403.

`POST /api/v1/problem-reports/{reference}/status` s `{status}` (`received` ili `resolved`) mijenja stanje prijave koja pozivatelju stiže; isto stanje ponovno ništa ne mijenja, a svaka promjena ostaje zapisana s ulogom onoga tko ju je napravio. Prijava koja pozivatelju ne stiže je 404. Obje putanje odlučuje baza (migracija `20261215100000_problem_report_routing.sql`); odgovor nosi `Cache-Control: no-store`.

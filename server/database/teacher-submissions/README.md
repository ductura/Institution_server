# Čitanje nastavničkih predaja

`createTeacherSubmissions` čita postojeći popis nastavničkih predaja i povezuje potvrđene predaje s njihovim identifikatorima. Oznaka `late` dolazi iz pohranjene predaje koja koristi rok utvrđen pri zahtjevu. Ako potvrda još nije vezana, popis prikazuje predaju s `submissionId: null`.

Za detalj se koristi postojeće čitanje predanog sadržaja. Ono ponovno provjerava pristup i bilježi otvaranje. Sažetak sadržaja mora odgovarati sažetku u vezanoj potvrdi.

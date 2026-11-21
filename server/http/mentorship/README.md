# HTTP rute za zahtjeve za mentorstvo

POST na `/api/v1/mentorship-requests` sprema studentov zahtjev. Rute `approve`, `decline` i `withdraw` na `/api/v1/mentorship-requests/{requestId}` mijenjaju stanje jednog zahtjeva. Baza provjerava odnos prema zahtjevu; tuđi i nepostojeći zahtjev daju isti 404.

Studentska strana (SRV-1414): GET `/api/v1/student/mentorship-requests` vraća studentove vlastite zahtjeve u svim stanjima, a GET `/api/v1/student/mentor-candidates` potvrđene nastavnike studentove ustanove kojima smije poslati zahtjev (samo id, ime i katedra). Nastavnik na tim rutama dobiva 403.

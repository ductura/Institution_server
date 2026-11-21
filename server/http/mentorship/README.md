# HTTP rute za zahtjeve za mentorstvo

POST na `/api/v1/mentorship-requests` sprema studentov zahtjev. Rute `approve`, `decline` i `withdraw` na `/api/v1/mentorship-requests/{requestId}` mijenjaju stanje jednog zahtjeva. Baza provjerava odnos prema zahtjevu; tuđi i nepostojeći zahtjev daju isti 404.

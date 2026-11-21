# Čitanje predane verzije

`createTeacherSubmissionReader` koristi postojeće nastavničke čitače za odnos sa zadatkom i provjeru predaje studenta. Oznaka `late` dolazi iz pohranjene predaje koja koristi rok utvrđen pri zahtjevu.

Čitanje sadržaja ponovno provjerava pristup i bilježi otvaranje. Poslužuje samo spremljene bajtove predane revizije koji odgovaraju sažetku pohranjenom uz predaju.

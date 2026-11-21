# Predana verzija za nastavnika

`GET /api/v1/teacher/assignments/{assignmentId}/submissions/{submissionId}` vraća tekst predanog JSON dokumenta i metapodatke predaje. Odgovor se ne sprema u predmemoriju. Pristup se provjerava prema odnosu sa zadatkom i radom, a čitanje predanog sadržaja bilježi se u dnevnik pristupa.

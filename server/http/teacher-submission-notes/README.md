# Napomene studenta za nastavnika

`GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission-notes` vraća napomene koje je student zapisao uz predaju (moguće prazan popis). Napomene nisu dio predaje, potvrde ni sažetka procesa. Odgovor se ne sprema u predmemoriju. Sadržaj koji ne odgovara ugovoru daje 503.

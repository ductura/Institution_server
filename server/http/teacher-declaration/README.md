# Izjava studenta za nastavnika

`GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration` vraća izjavu vezanu uz živu predaju studenta (`bound`) ili `none`. Odgovor se ne sprema u predmemoriju. Sadržaj koji ne odgovara ugovoru daje 503.

# Probni zadatak

Nastavnik zadatka na `GET /api/v1/teacher/assignments/{assignmentId}/grade` dobiva 409 za probni zadatak i `{ eligible: true }` za redovni. Pristup i status dolaze iz istog upita pod sesijom pozivatelja.

Pri montiranju ruta za izvoz PDF-a i Merlinova popisa poslužitelj dopušta nastavak samo za vidljivi redovni zadatak. Baza provjerava oznaku pri izradi Merlin paketa i pri čitanju izvora za DOCX.
